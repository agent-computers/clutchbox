import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { type Capture, type CapturedCookie, captureSchema, cookieSchema } from '@agent-computers/capture';
import { and, eq, isNotNull, like, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Database } from './database';
import type { Member } from './organizations';
import * as schema from './schema';

// Synced data at rest (captures.ts): sealed with AES-256-GCM under CAPTURE_ENCRYPTION_KEY, with its owner as associated
// data, so a sealed value opens only for the row it was written for. No 'server-only' here: the migration runner, a
// plain Node script, re-seals through it. Key rotation and object storage come later.
//
// A sealed value is `<version>.<iv>.<tag>.<data>`. v2 is bound to the membership, as everything is sealed now; v1 is
// bound to the person, as values sealed before data moved to memberships are, and is still opened until none is left.
export function captureKey(env: NodeJS.ProcessEnv = process.env) {
  const key = Buffer.from(env.CAPTURE_ENCRYPTION_KEY ?? '', 'base64');
  return key.length === 32 ? key : null;
}
export type Key = NonNullable<ReturnType<typeof captureKey>>;
// Whose data a sealed value is: the membership, and the person, for values sealed before memberships.
export type Owner = Pick<Member, 'userId' | 'membershipId'>;
type Purpose = 'capture' | 'capture-scope' | 'sync-settings' | 'applied-capture';
// The associated data for each version: the purpose, then the owner, then (for an applied capture) its computer.
const aad = (purpose: Purpose, owner: Owner, extra: string[] = []) => ({
  v1: Buffer.from([`agent-computers/${purpose}/v1`, owner.userId, ...extra].join(':')),
  v2: Buffer.from([`agent-computers/${purpose}/v2`, `membership-${owner.membershipId}`, ...extra].join(':')),
});
type Aad = ReturnType<typeof aad>;

function seal(plaintext: string, { v2 }: Aad, key: Key | null) {
  if (!key) throw new Error('sync_unavailable');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(v2);
  const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v2', iv, cipher.getAuthTag(), sealed]
    .map(part => (typeof part === 'string' ? part : part.toString('base64')))
    .join('.');
}
function openText(sealed: string, aads: Aad, key: Key | null): string {
  if (!key) throw new Error('sync_unavailable');
  const [version, iv, tag, data, ...rest] = sealed.split('.');
  const ivBytes = Buffer.from(iv ?? '', 'base64');
  const tagBytes = Buffer.from(tag ?? '', 'base64');
  // A pinned tag length: Node otherwise accepts truncated GCM tags.
  if ((version !== 'v1' && version !== 'v2') || !data || rest.length || ivBytes.length !== 12 || tagBytes.length !== 16)
    throw new Error('invalid sealed capture');
  const decipher = createDecipheriv('aes-256-gcm', key, ivBytes, { authTagLength: 16 })
    .setAAD(aads[version])
    .setAuthTag(tagBytes);
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
const open = (sealed: string, aads: Aad, key: Key | null): unknown => JSON.parse(openText(sealed, aads, key));
// Whether a sealed value is bound to the person rather than the membership, so a re-seal moves it.
export const sealedForPerson = (sealed: string) => sealed.startsWith('v1.');

export function sealCapture(capture: Capture, owner: Owner, key = captureKey()) {
  return seal(JSON.stringify(capture), aad('capture', owner), key);
}
export function openCapture(sealed: string, owner: Owner, key = captureKey()): Capture {
  return captureSchema.parse(open(sealed, aad('capture', owner), key));
}

// What a capture covers, without its exclusions: sealed apart from the capture (sealed_scope)
// so the account page can list synced sites without opening the cookies.
export type CaptureScope = { mode: 'sites' | 'whole-browser'; sites: string[] };
const scopeSchema = z.object({ mode: z.enum(['sites', 'whole-browser']), sites: z.array(z.string()) }).strict();
export function sealScope(scope: CaptureScope, owner: Owner, key = captureKey()) {
  return seal(JSON.stringify({ mode: scope.mode, sites: scope.sites }), aad('capture-scope', owner), key);
}
export function openScope(sealed: string, owner: Owner, key = captureKey()): CaptureScope {
  return scopeSchema.parse(open(sealed, aad('capture-scope', owner), key));
}

// Sync settings (sync_settings.sealed), parsed by their caller.
export function sealSettings(settings: unknown, owner: Owner, key: Key | null) {
  return seal(JSON.stringify(settings), aad('sync-settings', owner), key);
}
export function openSettings(sealed: string, owner: Owner, key: Key | null): unknown {
  return open(sealed, aad('sync-settings', owner), key);
}

// The last capture applied to a computer (computers.applied_capture): the baseline the next apply diffs against, bound
// to that computer's public ID too.
export type AppliedCapture = { completedAt: string; cookies: CapturedCookie[] };
const appliedSchema = z.object({ completedAt: z.string(), cookies: z.array(cookieSchema) }).strict();
export function sealAppliedCapture(applied: AppliedCapture, owner: Owner, computerId: string, key = captureKey()) {
  return seal(
    JSON.stringify({ completedAt: applied.completedAt, cookies: applied.cookies }),
    aad('applied-capture', owner, [computerId]),
    key,
  );
}
export function openAppliedCapture(sealed: string, owner: Owner, computerId: string, key = captureKey()) {
  return appliedSchema.parse(open(sealed, aad('applied-capture', owner, [computerId]), key));
}

// Re-seals what is still sealed for a person (v1) for the membership its row belongs to, so v1 can be retired. The
// migration runner runs it every time; it reads only rows with a v1 value, so once none is left it costs a query per
// table. The plaintext moves as it is, never parsed. A value that won't open is left as it is and counted, never
// deleted, and each write is conditional on the row's values not having changed meanwhile. Rows without a membership
// wait for the backfill. Without the key it changes nothing and counts the rows still waiting.
export async function resealForMemberships(db: Database, key = captureKey()) {
  const counts = { resealed: 0, unreadable: 0, waiting: 0 };
  const v1 = (column: AnyPgColumn) => like(column, 'v1.%');
  const move = (sealed: string | null, purpose: Purpose, owner: Owner, extra?: string[]) => {
    if (!sealed || !sealedForPerson(sealed)) return sealed;
    if (!key) {
      counts.waiting++;
      return sealed;
    }
    const aads = aad(purpose, owner, extra);
    try {
      const moved = seal(openText(sealed, aads, key), aads, key);
      counts.resealed++;
      return moved;
    } catch {
      counts.unreadable++;
      return sealed;
    }
  };
  const same = (column: AnyPgColumn, value: string | null) => sql`${column} IS NOT DISTINCT FROM ${value}`;

  const captures = await db
    .select({
      id: schema.captures.id,
      userId: schema.captures.userId,
      membershipId: schema.captures.membershipId,
      sealed: schema.captures.sealed,
      sealedScope: schema.captures.sealedScope,
    })
    .from(schema.captures)
    .where(
      and(isNotNull(schema.captures.membershipId), or(v1(schema.captures.sealed), v1(schema.captures.sealedScope))),
    );
  for (const row of captures) {
    const owner = { userId: row.userId, membershipId: row.membershipId! };
    const sealed = move(row.sealed, 'capture', owner)!;
    const sealedScope = move(row.sealedScope, 'capture-scope', owner);
    if (sealed === row.sealed && sealedScope === row.sealedScope) continue;
    await db
      .update(schema.captures)
      .set({ sealed, sealedScope })
      .where(
        and(
          sql`${schema.captures.id} = ${row.id}`,
          same(schema.captures.sealed, row.sealed),
          same(schema.captures.sealedScope, row.sealedScope),
        ),
      );
  }

  const settings = await db
    .select({
      id: schema.syncSettings.id,
      userId: schema.syncSettings.userId,
      membershipId: schema.syncSettings.membershipId,
      sealed: schema.syncSettings.sealed,
    })
    .from(schema.syncSettings)
    .where(and(isNotNull(schema.syncSettings.membershipId), v1(schema.syncSettings.sealed)));
  for (const row of settings) {
    const sealed = move(row.sealed, 'sync-settings', { userId: row.userId, membershipId: row.membershipId! })!;
    if (sealed === row.sealed) continue;
    await db
      .update(schema.syncSettings)
      .set({ sealed })
      .where(and(sql`${schema.syncSettings.id} = ${row.id}`, same(schema.syncSettings.sealed, row.sealed)));
  }

  const computers = await db
    .select({
      id: schema.computers.id,
      publicId: schema.computers.publicId,
      // A computer names only its membership; its person is the membership's.
      userId: schema.memberships.userId,
      membershipId: schema.computers.membershipId,
      appliedCapture: schema.computers.appliedCapture,
    })
    .from(schema.computers)
    .innerJoin(schema.memberships, eq(schema.memberships.id, schema.computers.membershipId))
    .where(v1(schema.computers.appliedCapture));
  for (const row of computers) {
    const owner = { userId: row.userId, membershipId: row.membershipId };
    const appliedCapture = move(row.appliedCapture, 'applied-capture', owner, [row.publicId]);
    if (appliedCapture === row.appliedCapture) continue;
    await db
      .update(schema.computers)
      .set({ appliedCapture })
      .where(and(sql`${schema.computers.id} = ${row.id}`, same(schema.computers.appliedCapture, row.appliedCapture)));
  }
  return counts;
}
