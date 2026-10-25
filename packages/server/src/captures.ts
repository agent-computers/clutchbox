import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  applySyncChange,
  type Capture,
  type CapturedCookie,
  captureDigest,
  captureSchema,
  cookieSchema,
  narrowCapture,
  type SyncChange,
  type SyncSettings,
  syncSettingsSchema,
} from '@agent-computers/capture';
import { and, eq, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from './database';
import { logError } from './log';
import * as schema from './schema';

// Validation prototype: the latest capture per user,
// sealed with AES-256-GCM under CAPTURE_ENCRYPTION_KEY and bound to the user ID.
// Key rotation and object storage come later.
export function captureKey(env: NodeJS.ProcessEnv = process.env) {
  const key = Buffer.from(env.CAPTURE_ENCRYPTION_KEY ?? '', 'base64');
  return key.length === 32 ? key : null;
}
const aad = (userId: string) => Buffer.from(`agent-computers/capture/v1:${userId}`);
const scopeAad = (userId: string) => Buffer.from(`agent-computers/capture-scope/v1:${userId}`);
const settingsAad = (userId: string) => Buffer.from(`agent-computers/sync-settings/v1:${userId}`);
const appliedAad = (userId: string, computerId: string) =>
  Buffer.from(`agent-computers/applied-capture/v1:${userId}:${computerId}`);
function seal(plaintext: string, aad: Buffer, key: Buffer | null) {
  if (!key) throw new Error('sync_unavailable');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(aad);
  const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), sealed]
    .map(part => (typeof part === 'string' ? part : part.toString('base64')))
    .join('.');
}
function open(sealed: string, aad: Buffer, key: Buffer | null): unknown {
  if (!key) throw new Error('sync_unavailable');
  const [version, iv, tag, data, ...rest] = sealed.split('.');
  const ivBytes = Buffer.from(iv ?? '', 'base64');
  const tagBytes = Buffer.from(tag ?? '', 'base64');
  // A pinned tag length: Node otherwise accepts truncated GCM tags.
  if (version !== 'v1' || !data || rest.length || ivBytes.length !== 12 || tagBytes.length !== 16)
    throw new Error('invalid sealed capture');
  const decipher = createDecipheriv('aes-256-gcm', key, ivBytes, { authTagLength: 16 })
    .setAAD(aad)
    .setAuthTag(tagBytes);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8'));
}
export function sealCapture(capture: Capture, userId: string, key = captureKey()) {
  return seal(JSON.stringify(capture), aad(userId), key);
}
export function openCapture(sealed: string, userId: string, key = captureKey()): Capture {
  return captureSchema.parse(open(sealed, aad(userId), key));
}
// What a capture covers, without its exclusions: sealed apart from the capture (sealed_scope)
// so the account page can list synced sites without opening the cookies.
export type CaptureScope = { mode: 'sites' | 'whole-browser'; sites: string[] };
const scopeSchema = z.object({ mode: z.enum(['sites', 'whole-browser']), sites: z.array(z.string()) }).strict();
const scopeOf = (capture: Capture): CaptureScope => ({
  mode: capture.scope.mode,
  sites: capture.scope.mode === 'sites' ? capture.scope.sites : [],
});
export function sealScope(scope: CaptureScope, userId: string, key = captureKey()) {
  return seal(JSON.stringify({ mode: scope.mode, sites: scope.sites }), scopeAad(userId), key);
}
export function openScope(sealed: string, userId: string, key = captureKey()): CaptureScope {
  return scopeSchema.parse(open(sealed, scopeAad(userId), key));
}

// The last capture applied to a computer (computers.applied_capture): the baseline the next apply diffs against.
export type AppliedCapture = { completedAt: string; cookies: CapturedCookie[] };
const appliedSchema = z.object({ completedAt: z.string(), cookies: z.array(cookieSchema) }).strict();
export function sealAppliedCapture(applied: AppliedCapture, userId: string, computerId: string, key = captureKey()) {
  return seal(
    JSON.stringify({ completedAt: applied.completedAt, cookies: applied.cookies }),
    appliedAad(userId, computerId),
    key,
  );
}
export function openAppliedCapture(sealed: string, userId: string, computerId: string, key = captureKey()) {
  return appliedSchema.parse(open(sealed, appliedAad(userId, computerId), key));
}

type Saved = {
  status: 'stored' | 'unchanged';
  completedAt: string;
  cookieCount: number;
  settings?: SyncSettings | undefined;
};
// sync_disconnected: Delete everything turned sync off until the extension reconnects, or this browser was disconnected.
// superseded: a deletion or a later upload was received after this upload.
// sync_paused: the account's settings are paused; the error carries them so the extension catches up.
export type SaveError = 'sync_unavailable' | 'sync_disconnected' | 'superseded' | 'sync_paused';
// Serializes uploads, settings changes, and deletions for one user, so a deletion always wins over an
// earlier-received upload and a stored capture never outlives a narrower setting.
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Key = NonNullable<ReturnType<typeof captureKey>>;
export const lockUser = (tx: Pick<Database, 'execute'>, userId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`captures:${userId}`}))`);

// Callers validate the capture with captureSchema and verify the sync token for userId.
// Ordering uses server receive time only; the client clock never decides which upload wins.
// With settings on the server, only the sites and exclusions they allow are stored.
// `browser` is the connected browser (connected_browsers.id) that sent it with a sync token.
export async function saveCapture(
  db: Database,
  userId: string,
  uploaded: Capture,
  {
    receivedAt = new Date(),
    connect = false,
    browser,
  }: { receivedAt?: Date | undefined; connect?: boolean | undefined; browser?: number | undefined } = {},
): Promise<Saved | { error: SaveError; settings?: SyncSettings | undefined }> {
  const key = captureKey();
  if (!key) return { error: 'sync_unavailable' };
  const fields = { completedAt: schema.captures.completedAt, cookieCount: schema.captures.cookieCount };
  return db.transaction(async (tx): Promise<Saved | { error: SaveError; settings?: SyncSettings | undefined }> => {
    await lockUser(tx, userId);
    // Under the lock and before `connect` can lift a disconnect, so a browser disconnected while this upload was in
    // flight never stores it.
    if (browser !== undefined) {
      const [row] = await tx
        .select({ disconnectedAt: schema.connectedBrowsers.disconnectedAt })
        .from(schema.connectedBrowsers)
        .where(eq(schema.connectedBrowsers.id, browser));
      if (!row || row.disconnectedAt) return { error: 'sync_disconnected' };
    }
    const [revoked] = await tx.select().from(schema.syncRevocations).where(eq(schema.syncRevocations.userId, userId));
    if (revoked?.disconnected && !connect) return { error: 'sync_disconnected' };
    if (revoked && revoked.deletedAt > receivedAt) return { error: 'superseded' };
    const settings = await readSettings(tx, userId, key);
    if (settings?.paused) return { error: 'sync_paused', settings };
    if (revoked?.disconnected)
      await tx
        .update(schema.syncRevocations)
        .set({ disconnected: false })
        .where(eq(schema.syncRevocations.userId, userId));
    const capture = settings ? narrowCapture(uploaded, settings) : uploaded;
    const digest = await captureDigest(capture.cookies);
    const sealed = sealCapture(capture, userId, key);
    const sealedScope = sealScope(scopeOf(capture), userId, key);
    const view = (row: { completedAt: Date; cookieCount: number }, status: Saved['status']): Saved => ({
      status,
      completedAt: row.completedAt.toISOString(),
      cookieCount: row.cookieCount,
      ...(settings ? { settings } : {}),
    });
    const synced = async (saved: Saved) => {
      if (browser !== undefined)
        await tx
          .update(schema.connectedBrowsers)
          .set({ lastSyncedAt: sql`greatest(${schema.connectedBrowsers.lastSyncedAt}, ${receivedAt})` })
          .where(eq(schema.connectedBrowsers.id, browser));
      return saved;
    };
    const sender = browser ?? null;
    // Same cookies: only the scope may have changed (an added site with no cookies yet).
    // An upload received before the stored one never overwrites its scope.
    const [same] = await tx
      .update(schema.captures)
      .set({
        uploadedAt: sql`greatest(${schema.captures.uploadedAt}, ${receivedAt})`,
        sealedScope: sql`case when ${schema.captures.uploadedAt} <= ${receivedAt} then ${sealedScope} else ${schema.captures.sealedScope} end`,
        connectedBrowserId: sql`case when ${schema.captures.uploadedAt} <= ${receivedAt} then ${sender}::bigint else ${schema.captures.connectedBrowserId} end`,
      })
      .where(and(eq(schema.captures.userId, userId), eq(schema.captures.digest, digest)))
      .returning(fields);
    if (same) return synced(view(same, 'unchanged'));
    // A clock running ahead must not show a future capture time.
    const completedAt = new Date(Math.min(Date.parse(capture.completedAt), receivedAt.getTime()));
    const values = {
      captureId: capture.id,
      digest,
      cookieCount: capture.cookies.length,
      sealed,
      sealedScope,
      completedAt,
      uploadedAt: receivedAt,
      connectedBrowserId: sender,
    };
    const [stored] = await tx
      .insert(schema.captures)
      .values({ userId, ...values })
      .onConflictDoUpdate({
        target: schema.captures.userId,
        set: values,
        setWhere: lte(schema.captures.uploadedAt, receivedAt),
      })
      .returning(fields);
    return stored ? synced(view(stored, 'stored')) : { error: 'superseded' };
  });
}

// Sync settings. Unreadable settings (no key, or a decrypt failure) count as none, so the extension's
// next adoption replaces them.
async function readSettings(tx: Pick<Database, 'select'>, userId: string, key: Key | null) {
  const [row] = await tx
    .select({ sealed: schema.syncSettings.sealed })
    .from(schema.syncSettings)
    .where(eq(schema.syncSettings.userId, userId));
  if (!row) return null;
  try {
    return syncSettingsSchema.parse(open(row.sealed, settingsAad(userId), key));
  } catch (error) {
    logError('sync settings', error);
    return null;
  }
}
async function writeSettings(tx: Transaction, userId: string, settings: SyncSettings, key: Key) {
  const values = { sealed: seal(JSON.stringify(settings), settingsAad(userId), key), updatedAt: new Date() };
  await tx
    .insert(schema.syncSettings)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: schema.syncSettings.userId, set: values });
}
// Re-seals the stored capture with only what the settings allow, so a removed site or new exclusion leaves the
// server at once rather than at the next upload. The new digest makes the next open apply it, which clears the
// removed sites on the computer. A capture that can't be opened is deleted.
async function narrowStoredCapture(tx: Transaction, userId: string, settings: SyncSettings, key: Key) {
  const [row] = await tx.select().from(schema.captures).where(eq(schema.captures.userId, userId));
  if (!row) return;
  let capture: Capture;
  try {
    capture = openCapture(row.sealed, userId, key);
  } catch (error) {
    logError('narrow capture', error);
    await tx.delete(schema.captures).where(eq(schema.captures.userId, userId));
    return;
  }
  const narrowed = narrowCapture(capture, settings);
  if (JSON.stringify(narrowed) === JSON.stringify(capture)) return;
  await tx
    .update(schema.captures)
    .set({
      digest: await captureDigest(narrowed.cookies),
      cookieCount: narrowed.cookies.length,
      sealed: sealCapture(narrowed, userId, key),
      sealedScope: sealScope(scopeOf(narrowed), userId, key),
    })
    .where(eq(schema.captures.userId, userId));
}

export type SyncView = { settings: SyncSettings | null; disconnected: boolean };
export async function syncView(db: Database, userId: string): Promise<SyncView> {
  const [[revoked], settings] = await Promise.all([
    db.select().from(schema.syncRevocations).where(eq(schema.syncRevocations.userId, userId)),
    readSettings(db, userId, captureKey()),
  ]);
  return { settings, disconnected: revoked?.disconnected ?? false };
}
// An extension's local settings become the account's only when it has none, so a second browser never overwrites
// them. Returns the account's settings either way.
export async function adoptSyncSettings(
  db: Database,
  userId: string,
  local: SyncSettings,
  serverSite: string,
): Promise<SyncSettings | { error: 'sync_unavailable' }> {
  const key = captureKey();
  if (!key) return { error: 'sync_unavailable' };
  return db.transaction(async tx => {
    await lockUser(tx, userId);
    const existing = await readSettings(tx, userId, key);
    if (existing) return existing;
    const settings = applySyncChange(local, {}, serverSite);
    await writeSettings(tx, userId, settings, key);
    await narrowStoredCapture(tx, userId, settings, key);
    return settings;
  });
}
// sync_settings_missing: nothing to change until an extension adopts settings for the account. Callers decide who
// may widen.
export async function changeSyncSettings(
  db: Database,
  userId: string,
  change: SyncChange,
  serverSite: string,
): Promise<SyncSettings | { error: 'sync_unavailable' | 'sync_settings_missing' }> {
  const key = captureKey();
  if (!key) return { error: 'sync_unavailable' };
  return db.transaction(async tx => {
    await lockUser(tx, userId);
    const existing = await readSettings(tx, userId, key);
    if (!existing) return { error: 'sync_settings_missing' as const };
    const settings = applySyncChange(existing, change, serverSite);
    await writeSettings(tx, userId, settings, key);
    await narrowStoredCapture(tx, userId, settings, key);
    return settings;
  });
}

// A later upload re-applies from scratch (no baseline: wholesale per site); synced sites stay recorded so it can clear them.
// The tombstone refuses uploads received before now; `disconnect` also refuses later ones.
// `forget` (Delete everything) also deletes the account's sync settings.
// `uploadedBy` (a connected browser's ID) deletes the capture only if that browser sent it, and otherwise does nothing.
type DeleteOptions = {
  disconnect?: boolean | undefined;
  forget?: boolean | undefined;
  uploadedBy?: number | undefined;
};
export async function deleteCaptures(db: Database, userId: string, options: DeleteOptions = {}) {
  await db.transaction(async tx => {
    await lockUser(tx, userId);
    await deleteCapturesIn(tx, userId, options);
  });
}
// deleteCaptures inside a caller's transaction, which already holds lockUser.
export async function deleteCapturesIn(
  tx: Transaction,
  userId: string,
  { disconnect = false, forget = false, uploadedBy }: DeleteOptions = {},
) {
  if (uploadedBy !== undefined) {
    const [mine] = await tx
      .select({ id: schema.captures.id })
      .from(schema.captures)
      .where(and(eq(schema.captures.userId, userId), eq(schema.captures.connectedBrowserId, uploadedBy)));
    if (!mine) return;
  }
  const deletedAt = new Date();
  await tx
    .insert(schema.syncRevocations)
    .values({ userId, deletedAt, disconnected: disconnect })
    .onConflictDoUpdate({
      target: schema.syncRevocations.userId,
      set: disconnect ? { deletedAt, disconnected: true } : { deletedAt },
    });
  await tx.delete(schema.captures).where(eq(schema.captures.userId, userId));
  if (forget) await tx.delete(schema.syncSettings).where(eq(schema.syncSettings.userId, userId));
  await tx
    .update(schema.computers)
    .set({ appliedCaptureDigest: null, appliedCapture: null })
    .where(eq(schema.computers.userId, userId));
}

export async function captureView(db: Database, userId: string) {
  const [row] = await db
    .select({
      completedAt: schema.captures.completedAt,
      uploadedAt: schema.captures.uploadedAt,
      cookieCount: schema.captures.cookieCount,
    })
    .from(schema.captures)
    .where(eq(schema.captures.userId, userId));
  return row
    ? {
        completedAt: row.completedAt.toISOString(),
        uploadedAt: row.uploadedAt.toISOString(),
        cookieCount: row.cookieCount,
      }
    : null;
}

// The latest capture's scope: null without a capture, 'unreadable' when it cannot be opened
// (no key, or a decrypt failure). Only sealed_scope is read, never the cookies, so a row stored
// before sealed_scope existed is also 'unreadable' until the extension's next upload fills it.
export async function captureScope(db: Database, userId: string): Promise<CaptureScope | null | 'unreadable'> {
  const [row] = await db
    .select({ sealedScope: schema.captures.sealedScope })
    .from(schema.captures)
    .where(eq(schema.captures.userId, userId));
  if (!row) return null;
  if (!row.sealedScope) return 'unreadable';
  try {
    return openScope(row.sealedScope, userId);
  } catch (error) {
    logError('capture scope', error);
    return 'unreadable';
  }
}

export async function latestCaptureDigest(db: Database, userId: string) {
  const [row] = await db
    .select({ digest: schema.captures.digest, completedAt: schema.captures.completedAt })
    .from(schema.captures)
    .where(eq(schema.captures.userId, userId));
  return row ? { digest: row.digest, completedAt: row.completedAt.toISOString() } : null;
}
export async function loadLatestCapture(db: Database, userId: string) {
  const [row] = await db.select().from(schema.captures).where(eq(schema.captures.userId, userId));
  return row
    ? { digest: row.digest, completedAt: row.completedAt.toISOString(), capture: openCapture(row.sealed, userId) }
    : null;
}
