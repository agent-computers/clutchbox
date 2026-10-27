import 'server-only';
import {
  applySyncChange,
  type Capture,
  captureDigest,
  narrowCapture,
  type SyncChange,
  type SyncSettings,
  syncSettingsSchema,
} from '@agent-computers/capture';
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Database } from './database';
import { logError } from './log';
import * as schema from './schema';
import {
  type CaptureScope,
  captureKey,
  type Key,
  type Owner,
  openCapture,
  openScope,
  openSettings,
  sealCapture,
  sealScope,
  sealSettings,
} from './sealing';

// The latest capture of each browser syncing to a member (browser_captures), sealed (sealing.ts) with the membership as
// associated data. Each is a profile on the member's computers (computers.ts, Profiles).
export {
  type AppliedCapture,
  type CaptureScope,
  captureKey,
  openAppliedCapture,
  openCapture,
  openScope,
  sealAppliedCapture,
  sealCapture,
  sealScope,
} from './sealing';

const scopeOf = (capture: Capture): CaptureScope => ({
  mode: capture.scope.mode,
  sites: capture.scope.mode === 'sites' ? capture.scope.sites : [],
});

type Saved = {
  status: 'stored' | 'unchanged';
  completedAt: string;
  cookieCount: number;
  settings?: SyncSettings | undefined;
};
// sync_disconnected: Delete everything turned sync off until the extension reconnects, or this browser signed out or was
// removed from the member.
// superseded: a deletion or a later upload was received after this upload.
// sync_paused: the account's settings are paused; the error carries them so the extension catches up.
export type SaveError = 'sync_unavailable' | 'sync_disconnected' | 'superseded' | 'sync_paused';
// Serializes uploads, settings changes, and deletions for one membership, so a deletion always wins over an
// earlier-received upload and a stored capture never outlives a narrower setting.
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export const lockMember = (tx: Pick<Database, 'execute'>, member: Pick<Owner, 'membershipId'>) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`captures:membership-${member.membershipId}`}))`);
// The rows of one membership in a table that carries membership_id.
const ownRow = (table: { membershipId: AnyPgColumn }, member: Pick<Owner, 'membershipId'>) =>
  eq(table.membershipId, member.membershipId);
const captures = schema.browserCaptures;
// One browser's capture in the member.
const browserRow = (member: Owner, browser: number) =>
  and(ownRow(captures, member), eq(captures.connectedBrowserId, browser));

// Whether a browser may upload to a member, under lockMember: signed in, and not removed there unless `connect` (the
// person added a site or chose all sites there in the extension) lifts the removal.
async function browserAdmitted(tx: Transaction, browser: number, member: Owner, connect: boolean) {
  const [row] = await tx
    .select({ disconnectedAt: schema.connectedBrowsers.disconnectedAt, removedAt: schema.browserMemberships.removedAt })
    .from(schema.connectedBrowsers)
    .leftJoin(
      schema.browserMemberships,
      and(
        eq(schema.browserMemberships.connectedBrowserId, schema.connectedBrowsers.id),
        eq(schema.browserMemberships.membershipId, member.membershipId),
      ),
    )
    .where(eq(schema.connectedBrowsers.id, browser));
  return !!row && !row.disconnectedAt && (!row.removedAt || connect);
}
// After an upload a browser was admitted for: records it in the member, lifting a removal, with when it synced.
async function browserSynced(tx: Transaction, browser: number, member: Owner, at: Date) {
  const rows = schema.browserMemberships;
  await tx
    .insert(rows)
    .values({ connectedBrowserId: browser, membershipId: member.membershipId, lastSyncedAt: at })
    .onConflictDoUpdate({
      target: [rows.connectedBrowserId, rows.membershipId],
      set: { removedAt: null, lastSyncedAt: sql`greatest(${rows.lastSyncedAt}, ${at})`, updatedAt: at },
    });
  await tx
    .update(schema.connectedBrowsers)
    .set({ lastSyncedAt: sql`greatest(${schema.connectedBrowsers.lastSyncedAt}, ${at})` })
    .where(eq(schema.connectedBrowsers.id, browser));
}
// Callers validate the capture with captureSchema and verify the sync token for the member.
// Ordering uses server receive time only; the client clock never decides which upload wins.
// With settings on the server, only the sites and exclusions they allow are stored.
// `browser` is the connected browser (connected_browsers.id) that sent it with a sync token: the capture is its own,
// and replaces only its earlier one.
export async function saveCapture(
  db: Database,
  member: Owner,
  uploaded: Capture,
  {
    receivedAt = new Date(),
    connect = false,
    browser,
  }: { receivedAt?: Date | undefined; connect?: boolean | undefined; browser: number },
): Promise<Saved | { error: SaveError; settings?: SyncSettings | undefined }> {
  const key = captureKey();
  if (!key) return { error: 'sync_unavailable' };
  const fields = { completedAt: captures.completedAt, cookieCount: captures.cookieCount };
  return db.transaction(async (tx): Promise<Saved | { error: SaveError; settings?: SyncSettings | undefined }> => {
    await lockMember(tx, member);
    // Under the lock and before `connect` can lift a disconnect, so a browser signed out or removed while this upload
    // was in flight never stores it.
    if (!(await browserAdmitted(tx, browser, member, connect))) return { error: 'sync_disconnected' };
    const [revoked] = await tx.select().from(schema.syncRevocations).where(ownRow(schema.syncRevocations, member));
    if (revoked?.disconnected && !connect) return { error: 'sync_disconnected' };
    if (revoked && revoked.deletedAt > receivedAt) return { error: 'superseded' };
    const settings = await readSettings(tx, member, key);
    if (settings?.paused) return { error: 'sync_paused', settings };
    if (revoked?.disconnected)
      await tx
        .update(schema.syncRevocations)
        .set({ disconnected: false })
        .where(ownRow(schema.syncRevocations, member));
    const capture = settings ? narrowCapture(uploaded, settings) : uploaded;
    const digest = await captureDigest(capture.cookies);
    const sealed = sealCapture(capture, member, key);
    const sealedScope = sealScope(scopeOf(capture), member, key);
    const view = (row: { completedAt: Date; cookieCount: number }, status: Saved['status']): Saved => ({
      status,
      completedAt: row.completedAt.toISOString(),
      cookieCount: row.cookieCount,
      ...(settings ? { settings } : {}),
    });
    const synced = async (saved: Saved) => {
      await browserSynced(tx, browser, member, receivedAt);
      return saved;
    };
    // Same cookies: only the scope may have changed (an added site with no cookies yet).
    // An upload received before the stored one never overwrites its scope.
    const [same] = await tx
      .update(captures)
      .set({
        uploadedAt: sql`greatest(${captures.uploadedAt}, ${receivedAt})`,
        sealedScope: sql`case when ${captures.uploadedAt} <= ${receivedAt} then ${sealedScope} else ${captures.sealedScope} end`,
      })
      .where(and(browserRow(member, browser), eq(captures.digest, digest)))
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
    };
    const [stored] = await tx
      .insert(captures)
      .values({ membershipId: member.membershipId, connectedBrowserId: browser, ...values })
      .onConflictDoUpdate({
        target: [captures.membershipId, captures.connectedBrowserId],
        set: values,
        setWhere: lte(captures.uploadedAt, receivedAt),
      })
      .returning(fields);
    return stored ? synced(view(stored, 'stored')) : { error: 'superseded' };
  });
}

// Sync settings. Unreadable settings (no key, or a decrypt failure) count as none, so the extension's
// next adoption replaces them.
async function readSettings(tx: Pick<Database, 'select'>, member: Owner, key: Key | null) {
  const [row] = await tx
    .select({ sealed: schema.syncSettings.sealed })
    .from(schema.syncSettings)
    .where(ownRow(schema.syncSettings, member));
  if (!row) return null;
  try {
    return syncSettingsSchema.parse(openSettings(row.sealed, member, key));
  } catch (error) {
    logError('sync settings', error);
    return null;
  }
}
async function writeSettings(tx: Transaction, member: Owner, settings: SyncSettings, key: Key) {
  const values = { sealed: sealSettings(settings, member, key), updatedAt: new Date() };
  await tx
    .insert(schema.syncSettings)
    .values({ membershipId: member.membershipId, ...values })
    .onConflictDoUpdate({ target: schema.syncSettings.membershipId, set: values });
}
// Re-seals each of the member's stored captures with only what the settings allow, so a removed site or new exclusion
// leaves the server at once rather than at the next upload. The new digest makes the next open apply it, which clears
// the removed sites on the computer. A capture that can't be opened is deleted.
async function narrowStoredCaptures(tx: Transaction, member: Owner, settings: SyncSettings, key: Key) {
  for (const row of await tx.select().from(captures).where(ownRow(captures, member))) {
    let capture: Capture;
    try {
      capture = openCapture(row.sealed, member, key);
    } catch (error) {
      logError('narrow capture', error);
      await tx.delete(captures).where(eq(captures.id, row.id));
      continue;
    }
    const narrowed = narrowCapture(capture, settings);
    if (JSON.stringify(narrowed) === JSON.stringify(capture)) continue;
    await tx
      .update(captures)
      .set({
        digest: await captureDigest(narrowed.cookies),
        cookieCount: narrowed.cookies.length,
        sealed: sealCapture(narrowed, member, key),
        sealedScope: sealScope(scopeOf(narrowed), member, key),
      })
      .where(eq(captures.id, row.id));
  }
}

export type SyncView = { settings: SyncSettings | null; disconnected: boolean };
export async function syncView(db: Database, member: Owner): Promise<SyncView> {
  const [[revoked], settings] = await Promise.all([
    db.select().from(schema.syncRevocations).where(ownRow(schema.syncRevocations, member)),
    readSettings(db, member, captureKey()),
  ]);
  return { settings, disconnected: revoked?.disconnected ?? false };
}
// An extension's local settings become the member's only when they have none, so a second browser never overwrites
// them. Returns the member's settings either way.
export async function adoptSyncSettings(
  db: Database,
  member: Owner,
  local: SyncSettings,
  serverSite: string,
): Promise<SyncSettings | { error: 'sync_unavailable' }> {
  const key = captureKey();
  if (!key) return { error: 'sync_unavailable' };
  return db.transaction(async tx => {
    await lockMember(tx, member);
    const existing = await readSettings(tx, member, key);
    if (existing) return existing;
    const settings = applySyncChange(local, {}, serverSite);
    await writeSettings(tx, member, settings, key);
    await narrowStoredCaptures(tx, member, settings, key);
    return settings;
  });
}
// sync_settings_missing: nothing to change until an extension adopts settings for the member. Callers decide who
// may widen.
export async function changeSyncSettings(
  db: Database,
  member: Owner,
  change: SyncChange,
  serverSite: string,
): Promise<SyncSettings | { error: 'sync_unavailable' | 'sync_settings_missing' }> {
  const key = captureKey();
  if (!key) return { error: 'sync_unavailable' };
  return db.transaction(async tx => {
    await lockMember(tx, member);
    const existing = await readSettings(tx, member, key);
    if (!existing) return { error: 'sync_settings_missing' as const };
    const settings = applySyncChange(existing, change, serverSite);
    await writeSettings(tx, member, settings, key);
    await narrowStoredCaptures(tx, member, settings, key);
    return settings;
  });
}

// Deletes captures and, with them, their baselines on the member's computers and on the snapshots forks start from, so a
// later upload re-applies from scratch (no baseline: wholesale per site); synced sites stay recorded so the next open
// can clear them. Without `browser`, every capture of the member, under a tombstone that refuses uploads received before
// now; `disconnect` also refuses later ones, and `forget` (Delete everything) deletes the member's sync settings too.
// With `browser` (a connected browser's ID), only that browser's capture and its profile's baselines, and no tombstone:
// the browser's removal or sign-out, under the same lock, refuses its uploads, and other browsers keep syncing.
type DeleteOptions = {
  disconnect?: boolean | undefined;
  forget?: boolean | undefined;
  browser?: number | undefined;
};
export async function deleteCaptures(db: Database, member: Owner, options: DeleteOptions = {}) {
  await db.transaction(async tx => {
    await lockMember(tx, member);
    await deleteCapturesIn(tx, member, options);
  });
}
// deleteCaptures inside a caller's transaction, which already holds lockMember.
export async function deleteCapturesIn(
  tx: Transaction,
  member: Owner,
  { disconnect = false, forget = false, browser }: DeleteOptions = {},
) {
  if (browser === undefined) {
    const deletedAt = new Date();
    await tx
      .insert(schema.syncRevocations)
      .values({ membershipId: member.membershipId, deletedAt, disconnected: disconnect })
      .onConflictDoUpdate({
        target: schema.syncRevocations.membershipId,
        set: disconnect ? { deletedAt, disconnected: true } : { deletedAt },
      });
  }
  await tx.delete(captures).where(browser === undefined ? ownRow(captures, member) : browserRow(member, browser));
  if (forget) await tx.delete(schema.syncSettings).where(ownRow(schema.syncSettings, member));
  const own = tx.select({ id: schema.computers.id }).from(schema.computers).where(ownRow(schema.computers, member));
  const profiles = schema.computerProfiles;
  await tx
    .update(profiles)
    .set({ appliedCaptureDigest: null, appliedCapture: null })
    .where(
      and(
        or(
          inArray(profiles.computerId, own),
          inArray(
            profiles.snapshotId,
            tx
              .select({ id: schema.computerSnapshots.id })
              .from(schema.computerSnapshots)
              .where(inArray(schema.computerSnapshots.computerId, own)),
          ),
        ),
        browser === undefined ? undefined : eq(profiles.connectedBrowserId, browser),
      ),
    );
}

// --- Profiles ---
// Each browser with a capture in the member is a profile there: its own Chrome profile on the member's computers, with
// its own sign-ins (computers.ts, Profiles), named by the browser's public ID. The default is the one that synced last.
// A browser that signs out, or is removed from the member, loses its capture and so its profile.
export type Profile = {
  // connected_browsers.id, which never leaves the server.
  browserId: number;
  id: string;
  browser: (typeof schema.BROWSER_NAMES)[number] | null;
  platform: (typeof schema.BROWSER_PLATFORMS)[number] | null;
  lastSyncedAt: string;
  default: boolean;
};
// A profile as it leaves the server.
export const profileView = ({ browserId: _browserId, ...view }: Profile) => view;
// The member's profiles, the default first, then by when each last synced.
export async function listProfiles(db: Pick<Database, 'select'>, member: Owner): Promise<Profile[]> {
  const browsers = schema.connectedBrowsers;
  const rows = await db
    .select({
      browserId: browsers.id,
      id: browsers.publicId,
      browser: browsers.browser,
      platform: browsers.platform,
      lastSyncedAt: captures.uploadedAt,
    })
    .from(captures)
    .innerJoin(browsers, eq(browsers.id, captures.connectedBrowserId))
    .innerJoin(
      schema.browserMemberships,
      and(
        eq(schema.browserMemberships.connectedBrowserId, browsers.id),
        eq(schema.browserMemberships.membershipId, captures.membershipId),
      ),
    )
    .where(and(ownRow(captures, member), isNull(browsers.disconnectedAt), isNull(schema.browserMemberships.removedAt)))
    .orderBy(desc(captures.uploadedAt), desc(captures.id));
  return rows.map((row, index) => ({ ...row, lastSyncedAt: row.lastSyncedAt.toISOString(), default: index === 0 }));
}

// The default profile's capture: the one uploaded last.
const latestFirst = [desc(captures.uploadedAt), desc(captures.id)];
export async function captureView(db: Database, member: Owner) {
  const [row] = await db
    .select({
      completedAt: captures.completedAt,
      uploadedAt: captures.uploadedAt,
      cookieCount: captures.cookieCount,
    })
    .from(captures)
    .where(ownRow(captures, member))
    .orderBy(...latestFirst)
    .limit(1);
  return row
    ? {
        completedAt: row.completedAt.toISOString(),
        uploadedAt: row.uploadedAt.toISOString(),
        cookieCount: row.cookieCount,
      }
    : null;
}

// The default profile's capture scope: null without a capture, 'unreadable' when it cannot be opened (no key, or a
// decrypt failure). Every browser captures the sites the member's sync settings name, so one scope stands for all. Only
// sealed_scope is read, never the cookies, so a row stored before sealed_scope existed is also 'unreadable' until the
// extension's next upload fills it.
export async function captureScope(db: Database, member: Owner): Promise<CaptureScope | null | 'unreadable'> {
  const [row] = await db
    .select({ sealedScope: captures.sealedScope })
    .from(captures)
    .where(ownRow(captures, member))
    .orderBy(...latestFirst)
    .limit(1);
  if (!row) return null;
  if (!row.sealedScope) return 'unreadable';
  try {
    return openScope(row.sealedScope, member);
  } catch (error) {
    logError('capture scope', error);
    return 'unreadable';
  }
}

// One browser's capture in the member: its digest, or the whole capture opened.
export async function latestCaptureDigest(db: Database, member: Owner, browser: number) {
  const [row] = await db
    .select({ digest: captures.digest, completedAt: captures.completedAt })
    .from(captures)
    .where(browserRow(member, browser));
  return row ? { digest: row.digest, completedAt: row.completedAt.toISOString() } : null;
}
export async function loadLatestCapture(db: Database, member: Owner, browser: number) {
  const [row] = await db.select().from(captures).where(browserRow(member, browser));
  return row
    ? { digest: row.digest, completedAt: row.completedAt.toISOString(), capture: openCapture(row.sealed, member) }
    : null;
}
