import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import type { Auth } from './auth';
import { loadLatestCapture } from './captures';
import type { Database } from './database';
import { logError } from './log';
import { API_KEY_PREFIX } from './organization-auth';
import * as schema from './schema';

// Organization API keys: what a developer's server presents to read the organization's members' synced state over
// REST. They are Better Auth's api-key plugin's (organization-auth.ts), which owners and admins create, list, and
// delete through its endpoints; the secret is shown once and only its SHA-256 is kept. A key acts for the
// organization, not for anyone in it, and a deleted key fails on its next request.

export type ApiKeyScope = (typeof schema.API_KEY_SCOPES)[number];

// The organization a key acts for, by its public ID, from `Authorization: Bearer ack_…`; null for anything else, a
// deleted key included. Its scopes are its permissions with the read action.
export type KeyPrincipal = { keyId: string; organizationId: string; scopes: ApiKeyScope[] };
export const isApiKeyAuthorization = (authorization: string) => authorization.startsWith(`Bearer ${API_KEY_PREFIX}`);
export async function apiKeyPrincipal(auth: Auth, authorization: string): Promise<KeyPrincipal | null> {
  if (!isApiKeyAuthorization(authorization)) return null;
  const secret = authorization.slice('Bearer '.length);
  if (secret.length > 100) return null;
  const { valid, key } = await auth.api.verifyApiKey({ body: { key: secret } });
  if (!valid || !key) return null;
  const raw: unknown = key.permissions;
  const permissions = (typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})) as Record<string, string[] | undefined>;
  const scopes = schema.API_KEY_SCOPES.filter(scope => permissions[scope]?.includes('read'));
  return { keyId: key.id, organizationId: key.referenceId, scopes };
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
