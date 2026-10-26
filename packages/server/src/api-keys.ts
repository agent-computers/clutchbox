import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';
import { loadLatestCapture } from './captures';
import type { Database } from './database';
import { newPublicId, publicIdPattern } from './ids';
import { logError } from './log';
import { manages, roleOf } from './members';
import type { Member } from './organizations';
import * as schema from './schema';

// Organization API keys: what a developer's server presents to read the organization's members' synced state over
// REST. Owners and admins create, list, and revoke them; the secret is shown once and only its SHA-256 is kept. A key
// acts for the organization, not for anyone in it, and a revoked key fails on its next request.

export type ApiKeyScope = (typeof schema.API_KEY_SCOPES)[number];
// The secret's prefix, so a key is told apart from an OAuth access token in Authorization, and from other secrets in
// a leaked file.
export const API_KEY_PREFIX = 'ack_';
export const API_KEY_ID_PATTERN = publicIdPattern('apiKey');
export const MAX_API_KEYS = 20;
// Last use is recorded at most this often, so a busy key doesn't write on every request.
const LAST_USED_RESOLUTION_MS = 60_000;

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('base64url');

export async function createApiKey(
  db: Database,
  member: Member,
  { name, scopes }: { name: string; scopes: ApiKeyScope[] },
) {
  const role = await roleOf(db, member);
  if (!role || !manages(role)) return { error: 'forbidden' } as const;
  const live = await db
    .select({ id: schema.apiKeys.id })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.organizationId, member.organizationId), isNull(schema.apiKeys.revokedAt)));
  if (live.length >= MAX_API_KEYS) return { error: 'api_key_limit' } as const;
  const secret = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const [key] = await db
    .insert(schema.apiKeys)
    .values({
      publicId: newPublicId('apiKey'),
      organizationId: member.organizationId,
      name,
      scopes: [...new Set(scopes)],
      tokenHash: hashSecret(secret),
      createdBy: member.membershipId,
    })
    .returning({
      id: schema.apiKeys.publicId,
      name: schema.apiKeys.name,
      scopes: schema.apiKeys.scopes,
      createdAt: schema.apiKeys.createdAt,
    });
  return { key: { ...key!, secret } };
}

// The organization's live keys, oldest first. Never their secrets.
export async function listApiKeys(db: Database, member: Member) {
  const role = await roleOf(db, member);
  if (!role || !manages(role)) return { error: 'forbidden' } as const;
  const keys = await db
    .select({
      id: schema.apiKeys.publicId,
      name: schema.apiKeys.name,
      scopes: schema.apiKeys.scopes,
      createdAt: schema.apiKeys.createdAt,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      createdBy: schema.user.name,
    })
    .from(schema.apiKeys)
    .leftJoin(schema.memberships, eq(schema.memberships.id, schema.apiKeys.createdBy))
    .leftJoin(schema.user, eq(schema.user.id, schema.memberships.userId))
    .where(and(eq(schema.apiKeys.organizationId, member.organizationId), isNull(schema.apiKeys.revokedAt)))
    .orderBy(asc(schema.apiKeys.id));
  return { keys };
}

export async function revokeApiKey(db: Database, member: Member, keyId: string, now = new Date()) {
  const role = await roleOf(db, member);
  if (!role || !manages(role)) return { error: 'forbidden' } as const;
  const [revoked] = await db
    .update(schema.apiKeys)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.apiKeys.publicId, keyId),
        eq(schema.apiKeys.organizationId, member.organizationId),
        isNull(schema.apiKeys.revokedAt),
      ),
    )
    .returning({ id: schema.apiKeys.id });
  return revoked ? { revoked: true as const } : ({ error: 'not_found' } as const);
}

// The organization a key acts for, from `Authorization: Bearer ack_…`; null for anything else, a revoked key included.
export type KeyPrincipal = { keyId: number; organizationId: number; scopes: ApiKeyScope[] };
export const isApiKeyAuthorization = (authorization: string) => authorization.startsWith(`Bearer ${API_KEY_PREFIX}`);
export async function apiKeyPrincipal(db: Database, authorization: string, now = new Date()) {
  if (!isApiKeyAuthorization(authorization)) return null;
  const secret = authorization.slice('Bearer '.length);
  if (secret.length > 100) return null;
  const [key] = await db
    .select({ keyId: schema.apiKeys.id, organizationId: schema.apiKeys.organizationId, scopes: schema.apiKeys.scopes })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.tokenHash, hashSecret(secret)), isNull(schema.apiKeys.revokedAt)));
  if (!key) return null;
  await db
    .update(schema.apiKeys)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(schema.apiKeys.id, key.keyId),
        or(
          isNull(schema.apiKeys.lastUsedAt),
          lt(schema.apiKeys.lastUsedAt, new Date(now.getTime() - LAST_USED_RESOLUTION_MS)),
        ),
      ),
    );
  return key as KeyPrincipal;
}

// The organization's members, for a key to address them by ID, with when each last synced.
export async function membersForKey(db: Database, key: KeyPrincipal) {
  return db
    .select({
      id: schema.memberships.publicId,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.memberships.role,
      lastSyncedAt: schema.captures.completedAt,
    })
    .from(schema.memberships)
    .innerJoin(schema.user, eq(schema.user.id, schema.memberships.userId))
    .leftJoin(schema.captures, eq(schema.captures.membershipId, schema.memberships.id))
    .where(eq(schema.memberships.organizationId, key.organizationId))
    .orderBy(asc(schema.memberships.id));
}

// A member's latest capture, in the capture format. Needs the captures scope; another organization's member is not
// found. 'unreadable' when it can't be opened (no key on this server, or a decrypt failure).
export async function latestCaptureForKey(db: Database, key: KeyPrincipal, membershipPublicId: string) {
  if (!key.scopes.includes('captures')) return { error: 'insufficient_scope' } as const;
  const [member] = await db
    .select({
      userId: schema.memberships.userId,
      membershipId: schema.memberships.id,
      organizationId: schema.memberships.organizationId,
    })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.publicId, membershipPublicId),
        eq(schema.memberships.organizationId, key.organizationId),
      ),
    );
  if (!member) return { error: 'not_found' } as const;
  try {
    const latest = await loadLatestCapture(db, member);
    if (!latest) return { error: 'no_capture' } as const;
    return { member: membershipPublicId, completedAt: latest.completedAt, capture: latest.capture };
  } catch (error) {
    logError('api key capture', error);
    return { error: 'capture_unreadable' } as const;
  }
}
