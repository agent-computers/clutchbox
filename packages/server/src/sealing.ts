import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { type Capture, type CapturedCookie, captureSchema, cookieSchema } from '@agent-computers/capture';
import { z } from 'zod';
import type { Member } from './organizations';

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
function open(sealed: string, aads: Aad, key: Key | null): unknown {
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
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8'));
}
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
