import 'server-only';
import { and, asc, eq, max } from 'drizzle-orm';
import type { Auth } from './auth';
import { listProfiles, loadLatestCapture } from './captures';
import { type Caller, type ComputerFailure, SESSION_ID_PATTERN } from './computers';
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
const scopesOf = (raw: unknown) => {
  const permissions = (typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})) as Record<string, string[] | undefined>;
  return schema.API_KEY_SCOPES.filter(scope => permissions[scope]?.includes('read'));
};
export const isApiKeyAuthorization = (authorization: string) => authorization.startsWith(`Bearer ${API_KEY_PREFIX}`);
export async function apiKeyPrincipal(auth: Auth, authorization: string): Promise<KeyPrincipal | null> {
  if (!isApiKeyAuthorization(authorization)) return null;
  const secret = authorization.slice('Bearer '.length);
  if (secret.length > 100) return null;
  const { valid, key } = await auth.api.verifyApiKey({ body: { key: secret } });
  if (!valid || !key) return null;
  return { keyId: key.id, organizationId: key.referenceId, scopes: scopesOf(key.permissions) };
}

// Whether a key still works with the scope: not deleted, disabled, or expired. Read straight from its row, inside the
// computer service's transactions (a computer session's guard) and by the CDP proxy as it runs, where verifying the
// secret again is not possible.
export async function keyHasScope(db: Pick<Database, 'select'>, keyId: string, scope: ApiKeyScope, now = new Date()) {
  const [key] = await db
    .select({
      enabled: schema.apikey.enabled,
      expiresAt: schema.apikey.expiresAt,
      permissions: schema.apikey.permissions,
    })
    .from(schema.apikey)
    .where(eq(schema.apikey.id, keyId));
  if (!key || key.enabled === false || (key.expiresAt && key.expiresAt <= now)) return false;
  return scopesOf(key.permissions).includes(scope);
}

// The caller a key's computer sessions run as (computers.ts): for one member of its organization, as the key, whose
// computers scope every call re-checks.
export const keyCaller = (member: Omit<Caller, 'apiKeyId' | 'clientId' | 'guard'>, keyId: string): Caller => ({
  ...member,
  apiKeyId: keyId,
  guard: tx => keyHasScope(tx, keyId, 'computers'),
});
const scopeRefused = { error: 'insufficient_scope' } as const;
const sessionNotFound: ComputerFailure = {
  error: 'session_not_found',
  message: 'No such computer session for this API key. Open one with POST /api/v1/computers/sessions.',
};

// The caller for opening a computer session for a member of the key's organization, by the membership's public ID.
// Needs the computers scope; another organization's member is not found.
export async function computerCallerForMember(db: Database, key: KeyPrincipal, membershipPublicId: string) {
  if (!key.scopes.includes('computers')) return scopeRefused;
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
  return member ? keyCaller(member, key.keyId) : ({ error: 'not_found' } as const);
}

// The caller for one of the key's own computer sessions, by its ID: the session's member, as the key. Another key's
// session, even in the same organization, is not found.
export async function computerCallerForSession(
  db: Database,
  key: KeyPrincipal,
  sessionId: string,
): Promise<Caller | typeof scopeRefused | ComputerFailure> {
  if (!key.scopes.includes('computers')) return scopeRefused;
  if (!SESSION_ID_PATTERN.test(sessionId)) return sessionNotFound;
  const [member] = await db
    .select({
      userId: schema.memberships.userId,
      membershipId: schema.memberships.id,
      organizationId: schema.memberships.organizationId,
    })
    .from(schema.computerSessions)
    .innerJoin(schema.memberships, eq(schema.memberships.id, schema.computerSessions.membershipId))
    .where(
      and(
        eq(schema.computerSessions.publicId, sessionId),
        eq(schema.computerSessions.apiKeyId, key.keyId),
        eq(schema.memberships.organizationId, key.organizationId),
      ),
    );
  return member ? keyCaller(member, key.keyId) : sessionNotFound;
}

// The organization's members, for a key to address them by ID, with when each last synced: the newest capture of any of
// their browsers.
export async function membersForKey(db: Database, key: KeyPrincipal) {
  return db
    .select({
      id: schema.memberships.publicId,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.memberships.role,
      lastSyncedAt: max(schema.browserCaptures.completedAt),
    })
    .from(schema.memberships)
    .innerJoin(schema.user, eq(schema.user.id, schema.memberships.userId))
    .leftJoin(schema.browserCaptures, eq(schema.browserCaptures.membershipId, schema.memberships.id))
    .where(eq(schema.memberships.organizationId, key.organizationId))
    .groupBy(schema.memberships.id, schema.user.id)
    .orderBy(asc(schema.memberships.id));
}

// A member's latest capture, in the capture format: one profile's (captures.ts, Profiles), by its browser's public ID,
// or the default's. Needs the captures scope; another organization's member is not found, and so is a profile that is
// not theirs. 'unreadable' when it can't be opened (no key on this server, or a decrypt failure).
export async function latestCaptureForKey(
  db: Database,
  key: KeyPrincipal,
  membershipPublicId: string,
  profileId?: string | undefined,
) {
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
  const profiles = await listProfiles(db, member);
  const profile = profileId === undefined ? profiles[0] : profiles.find(each => each.id === profileId);
  if (!profile) return profileId === undefined ? ({ error: 'no_capture' } as const) : ({ error: 'not_found' } as const);
  try {
    const latest = await loadLatestCapture(db, member, profile.browserId);
    if (!latest) return { error: 'no_capture' } as const;
    return {
      member: membershipPublicId,
      profile: profile.id,
      completedAt: latest.completedAt,
      capture: latest.capture,
    };
  } catch (error) {
    logError('api key capture', error);
    return { error: 'capture_unreadable' } as const;
  }
}
