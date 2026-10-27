import 'server-only';
import { createHash } from 'node:crypto';
import { extensionClientId, refreshReuseSeconds, syncScope } from '@agent-computers/capture';
import { and, asc, eq, exists, gt, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { deleteCaptures, deleteCapturesIn, lockMember } from './captures';
import type { Database } from './database';
import { newPublicId, publicIdPattern } from './ids';
import { currentMember, type Member } from './organizations';
import * as schema from './schema';

// Browsers connected with OAuth. The extension is a first-party client of our Better Auth server whose
// opaque `sync` tokens work only on the extension's routes. A connected browser is one refresh-token family: the
// authorization code it started from (authorization_code_id), which every rotation carries over. It is signed in to
// the person's account and syncs to each of their organizations it has sites for, each request naming one.

// Not a URL, so CIMD never registers, refreshes, or links it to the MCP resource, and it survives a hostname change.
// The oauth_client CHECK in oauth-schema.ts names it too. Shared with the extension's client (packages/capture).
export const EXTENSION_CLIENT_ID = extensionClientId;
export const SYNC_SCOPE = syncScope;
// Access token lifetime: how long a token outlives a disconnect it missed. Five minutes, as for MCP tokens; the
// extension refreshes as needed.
export const ACCESS_TOKEN_SECONDS = 300;
// Refresh token lifetime, unused: each refresh issues a new token with a fresh 30 days, so a browser left closed for a
// month reconnects and one in use never does.
export const REFRESH_TOKEN_SECONDS = 60 * 60 * 24 * 30;
// How long a rotated refresh token still gets the same answer, so a refresh whose response was lost can retry. mcp()'s
// default; after it, presenting a rotated token counts as theft. The extension's refresh timings derive from it.
export const REFRESH_REUSE_SECONDS = refreshReuseSeconds;
export const BROWSER_ID_PATTERN = publicIdPattern('browser');

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
// The pinned extension origins in EXTENSION_ORIGINS, well-formed ones only.
export const extensionOrigins = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map(entry => entry.trim().toLowerCase().replace(/\/+$/, ''))
    .filter(entry => EXTENSION_ORIGIN.test(entry));

// The client's metadata document, served at /oauth/extension-client.json, and the source of its oauth_client row.
export function extensionClientMetadata(originsEnv: string | undefined) {
  return {
    client_id: EXTENSION_CLIENT_ID,
    client_name: 'Clutchbox extension',
    redirect_uris: extensionOrigins(originsEnv).map(origin => `${origin}/connected.html`),
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
    scope: `offline_access ${SYNC_SCOPE}`,
  };
}

// Writes the client row once per instance. Every column is set, so nothing another path wrote (a resource link, a
// secret, an owner) survives; `disabled` is left alone, so an operator can switch the extension off.
export async function ensureExtensionClient(db: Database, originsEnv: string | undefined) {
  const metadata = extensionClientMetadata(originsEnv);
  const now = new Date();
  const values = {
    clientId: EXTENSION_CLIENT_ID,
    clientSecret: null,
    clientDiscoveryId: null,
    skipConsent: true,
    enableEndSession: null,
    subjectType: null,
    scopes: metadata.scope.split(' '),
    clientCredentialsScopes: [],
    userId: null,
    updatedAt: now,
    name: metadata.client_name,
    uri: null,
    icon: null,
    contacts: null,
    tos: null,
    policy: null,
    softwareId: null,
    softwareVersion: null,
    softwareStatement: null,
    redirectUris: metadata.redirect_uris,
    postLogoutRedirectUris: null,
    backchannelLogoutUri: null,
    backchannelLogoutSessionRequired: null,
    tokenEndpointAuthMethod: metadata.token_endpoint_auth_method,
    applicationType: metadata.application_type,
    jwks: null,
    jwksUri: null,
    grantTypes: metadata.grant_types,
    responseTypes: metadata.response_types,
    requirePKCE: true,
    dpopBoundAccessTokens: false,
    referenceId: null,
    metadata: null,
  };
  await db.transaction(async tx => {
    await tx
      .insert(schema.oauthClient)
      .values({ id: EXTENSION_CLIENT_ID, disabled: false, createdAt: now, ...values })
      .onConflictDoUpdate({ target: schema.oauthClient.id, set: values });
    await tx.delete(schema.oauthClientResource).where(eq(schema.oauthClientResource.clientId, EXTENSION_CLIENT_ID));
  });
}

// Better Auth's default `hashed` token storage: SHA-256, base64url without padding.
const hashToken = (token: string) => createHash('sha256').update(token).digest('base64url');
const BEARER = /^bearer +([A-Za-z0-9._~-]{1,512})$/i;
const extensionTokens = (table: typeof schema.oauthAccessToken | typeof schema.oauthRefreshToken, userId: string) =>
  and(eq(table.userId, userId), eq(table.clientId, EXTENSION_CLIENT_ID));

export type SyncPrincipal = {
  id: string;
  name: string;
  email: string;
  browser: { id: number; publicId: string };
  // The membership the request acts in: in the organization it names (organizationHeader), or for a request naming
  // none, the one the browser connected in. Null when the person is not a member there.
  member: Member | null;
};
// The account, browser, and membership behind a sync token, or null. Checks the token row itself (unrevoked, unexpired, the sync
// scope), the account (verified, not banned), the client (enabled), and the browser (not signed out). The web
// session is never consulted: a browser syncs to the account that connected it until it signs out.
export async function syncPrincipal(
  db: Database,
  {
    authorization,
    organization,
    userAgent,
    now = new Date(),
  }: {
    authorization: string | undefined;
    organization?: string | undefined;
    userAgent?: string | undefined;
    now?: Date;
  },
): Promise<SyncPrincipal | null> {
  const token = BEARER.exec(authorization?.trim() ?? '')?.[1];
  if (!token) return null;
  const access = schema.oauthAccessToken;
  const [found] = await db
    .select({
      userId: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      authorizationCodeId: access.authorizationCodeId,
    })
    .from(access)
    .innerJoin(
      schema.user,
      and(eq(schema.user.id, access.userId), eq(schema.user.emailVerified, true), schema.notBanned),
    )
    .innerJoin(
      schema.oauthClient,
      and(eq(schema.oauthClient.clientId, access.clientId), sql`${schema.oauthClient.disabled} is not true`),
    )
    .where(
      and(
        eq(access.token, hashToken(token)),
        eq(access.clientId, EXTENSION_CLIENT_ID),
        isNull(access.revoked),
        gt(access.expiresAt, now),
        sql`${SYNC_SCOPE} = any(${access.scopes})`,
        isNotNull(access.authorizationCodeId),
      ),
    )
    .limit(1);
  if (!found?.authorizationCodeId) return null;
  const family = found.authorizationCodeId;
  // Recorded at the code exchange (recordBrowser); this covers a browser whose record that missed.
  await recordFamily(db, found.userId, family, userAgent, now);
  const browsers = schema.connectedBrowsers;
  const [row] = await db
    .select({
      id: browsers.id,
      publicId: browsers.publicId,
      userId: browsers.userId,
      membershipId: browsers.membershipId,
      disconnectedAt: browsers.disconnectedAt,
    })
    .from(browsers)
    .where(eq(browsers.authorizationCodeId, family));
  if (!row || row.userId !== found.userId || row.disconnectedAt) return null;
  await pruneFamily(db, found.userId, family, now);
  const member =
    organization === undefined
      ? await memberIn(db, found.userId, { membershipId: row.membershipId })
      : await memberIn(db, found.userId, { organizationId: organization });
  return {
    id: found.userId,
    name: found.name,
    email: found.email,
    browser: { id: row.id, publicId: row.publicId },
    member,
  };
}
async function memberIn(
  db: Database,
  userId: string,
  where: { organizationId: string } | { membershipId: number | null },
): Promise<Member | null> {
  const memberships = schema.memberships;
  if ('membershipId' in where && where.membershipId === null) return null;
  const [member] = await db
    .select({ userId: memberships.userId, membershipId: memberships.id, organizationId: memberships.organizationId })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        'organizationId' in where
          ? eq(memberships.organizationId, where.organizationId)
          : eq(memberships.id, where.membershipId!),
      ),
    );
  return member ?? null;
}
// Records a family's browser for the person, noting the membership they act in for builds that name no organization.
// Never overwrites, so a tombstone always wins; it only fills the person on a row written before browsers belonged to
// people.
async function recordFamily(db: Database, userId: string, family: string, userAgent: string | undefined, now: Date) {
  const member = await currentMember(db, userId);
  const browsers = schema.connectedBrowsers;
  await db
    .insert(browsers)
    .values({
      publicId: newPublicId('browser', now.getTime()),
      userId,
      membershipId: member?.membershipId ?? null,
      authorizationCodeId: family,
      ...browserOf(userAgent),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: browsers.authorizationCodeId,
      set: { userId },
      setWhere: sql`${browsers.userId} is null and ${exists(
        db
          .select({ id: schema.memberships.id })
          .from(schema.memberships)
          .where(and(eq(schema.memberships.id, browsers.membershipId), eq(schema.memberships.userId, userId))),
      )}`,
    });
}
// Records the browser behind a freshly issued sync token. The token endpoint's after-hook (auth.ts) calls it, so a
// browser is known, and can sign out, from its code exchange on.
export async function recordBrowser(
  db: Database,
  { accessToken, userAgent, now = new Date() }: { accessToken: string; userAgent?: string | undefined; now?: Date },
) {
  const access = schema.oauthAccessToken;
  const [found] = await db
    .select({ userId: access.userId, family: access.authorizationCodeId })
    .from(access)
    .where(and(eq(access.token, hashToken(accessToken)), eq(access.clientId, EXTENSION_CLIENT_ID)));
  if (found?.userId && found.family) await recordFamily(db, found.userId, found.family, userAgent, now);
}
// Better Auth never deletes opaque access tokens or rotated refresh tokens. Expired ones of this family go here (an
// access token's refresh_id cascade takes its access tokens along); rotated, unexpired refresh tokens stay, since
// presenting one is how theft is detected.
async function pruneFamily(db: Database, userId: string, family: string, now: Date) {
  for (const table of [schema.oauthAccessToken, schema.oauthRefreshToken])
    await db
      .delete(table)
      .where(and(extensionTokens(table, userId), eq(table.authorizationCodeId, family), lte(table.expiresAt, now)));
}

// Whether the member removed this browser, which the extension answers by dropping the organization's sites.
export async function browserRemoved(db: Database, browser: number, member: Owner) {
  const [row] = await db
    .select({ removedAt: schema.browserMemberships.removedAt })
    .from(schema.browserMemberships)
    .where(
      and(
        eq(schema.browserMemberships.connectedBrowserId, browser),
        eq(schema.browserMemberships.membershipId, member.membershipId),
      ),
    );
  return !!row?.removedAt;
}

// The member whose browsers these are, with the person: Better Auth keys the extension's tokens by user.
type Owner = Pick<Member, 'userId' | 'membershipId'>;
export type ConnectedBrowser = {
  id: string;
  browser: (typeof schema.BROWSER_NAMES)[number] | null;
  platform: (typeof schema.BROWSER_PLATFORMS)[number] | null;
  connectedAt: Date;
  lastSyncedAt: Date | null;
};
// The browsers syncing to the member: recorded there and not removed, signed in, and still holding a live refresh
// token.
export async function listBrowsers(db: Database, member: Owner, now = new Date()): Promise<ConnectedBrowser[]> {
  const { userId } = member;
  const browsers = schema.connectedBrowsers;
  const rows = schema.browserMemberships;
  const refresh = schema.oauthRefreshToken;
  return db
    .select({
      id: browsers.publicId,
      browser: browsers.browser,
      platform: browsers.platform,
      connectedAt: browsers.createdAt,
      lastSyncedAt: rows.lastSyncedAt,
    })
    .from(rows)
    .innerJoin(browsers, eq(browsers.id, rows.connectedBrowserId))
    .where(
      and(
        eq(rows.membershipId, member.membershipId),
        isNull(rows.removedAt),
        isNull(browsers.disconnectedAt),
        exists(
          db
            .select({ id: refresh.id })
            .from(refresh)
            .where(
              and(
                extensionTokens(refresh, userId),
                eq(refresh.authorizationCodeId, browsers.authorizationCodeId),
                isNull(refresh.revoked),
                gt(refresh.expiresAt, now),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(browsers.createdAt), asc(browsers.id));
}

// Removes one browser from the member, by its public ID (the Browser sync page), deleting the capture if it sent it.
// It keeps syncing to the person's other organizations. False when it is not syncing to the member.
export async function removeBrowser(db: Database, member: Owner, publicId: string) {
  return db.transaction(async tx => {
    await lockMember(tx, member);
    const rows = schema.browserMemberships;
    const [row] = await tx
      .select({ id: rows.id, browser: rows.connectedBrowserId })
      .from(rows)
      .innerJoin(schema.connectedBrowsers, eq(schema.connectedBrowsers.id, rows.connectedBrowserId))
      .where(
        and(
          eq(rows.membershipId, member.membershipId),
          isNull(rows.removedAt),
          isNull(schema.connectedBrowsers.disconnectedAt),
          eq(schema.connectedBrowsers.publicId, publicId),
        ),
      );
    if (!row) return false;
    await tx.update(rows).set({ removedAt: new Date() }).where(eq(rows.id, row.id));
    await deleteCapturesIn(tx, member, { uploadedBy: row.browser });
    return true;
  });
}
// Removes every browser from the member (Delete everything, Turn off sync), each still syncing to the person's other
// organizations. The capture is the caller's.
export async function removeAllBrowsers(db: Database, member: Owner) {
  await db.transaction(async tx => {
    await lockMember(tx, member);
    const rows = schema.browserMemberships;
    await tx
      .update(rows)
      .set({ removedAt: new Date() })
      .where(and(eq(rows.membershipId, member.membershipId), isNull(rows.removedAt)));
  });
}

// Signs a family out: tombstones it and deletes its tokens, so it syncs nowhere, then deletes each capture it sent in
// any of the person's organizations. The tombstone commits first, so an upload that was already admitted finishes
// before its capture is deleted, and any later one is refused.
async function signOutFamily(db: Database, userId: string, family: string, now: Date) {
  const browsers = schema.connectedBrowsers;
  const [row] = await db.transaction(async tx => {
    const tombstoned = await tx
      .insert(browsers)
      .values({
        publicId: newPublicId('browser', now.getTime()),
        userId,
        authorizationCodeId: family,
        disconnectedAt: now,
      })
      .onConflictDoUpdate({
        target: browsers.authorizationCodeId,
        set: {
          disconnectedAt: sql`coalesce(${browsers.disconnectedAt}, ${now})`,
          browser: null,
          platform: null,
          lastSyncedAt: null,
        },
      })
      .returning({ id: browsers.id, membershipId: browsers.membershipId });
    for (const table of [schema.oauthAccessToken, schema.oauthRefreshToken])
      await tx.delete(table).where(and(extensionTokens(table, userId), eq(table.authorizationCodeId, family)));
    return tombstoned;
  });
  if (!row) return;
  const recorded = await db
    .select({ membershipId: schema.browserMemberships.membershipId })
    .from(schema.browserMemberships)
    .where(eq(schema.browserMemberships.connectedBrowserId, row.id));
  const memberships = new Set([
    ...recorded.map(each => each.membershipId),
    ...(row.membershipId ? [row.membershipId] : []),
  ]);
  for (const membershipId of memberships) await deleteCaptures(db, { membershipId }, { uploadedBy: row.id });
}
// The extension's Sign out, with its own token.
export async function signOutBrowser(db: Database, userId: string, browser: number) {
  const [row] = await db
    .select({ family: schema.connectedBrowsers.authorizationCodeId })
    .from(schema.connectedBrowsers)
    .where(and(eq(schema.connectedBrowsers.id, browser), eq(schema.connectedBrowsers.userId, userId)));
  if (row) await signOutFamily(db, userId, row.family, new Date());
}

// Refresh-token theft, one browser at a time. Before Better Auth sees an extension refresh, true refuses it: the
// family is signed out, or the token was rotated more than the reuse window ago, which signs out only this family.
// Better Auth would instead delete every family of the client for the user, so one replay would sign out every
// browser. Anything else (unknown, expired, a retry within the window) is Better Auth's to answer.
export async function guardExtensionRefresh(
  db: Database,
  { refreshToken, now = new Date() }: { refreshToken: string; now?: Date },
) {
  const refresh = schema.oauthRefreshToken;
  const [row] = await db
    .select({
      userId: refresh.userId,
      clientId: refresh.clientId,
      family: refresh.authorizationCodeId,
      revoked: refresh.revoked,
      replayUntil: refresh.rotationReplayExpiresAt,
    })
    .from(refresh)
    .where(eq(refresh.token, hashToken(refreshToken)));
  if (!row || row.clientId !== EXTENSION_CLIENT_ID) return false;
  const family = row.family;
  if (family) {
    const [browser] = await db
      .select({ disconnectedAt: schema.connectedBrowsers.disconnectedAt })
      .from(schema.connectedBrowsers)
      .where(eq(schema.connectedBrowsers.authorizationCodeId, family));
    if (browser?.disconnectedAt) return true;
  }
  if (!row.revoked || (row.replayUntil && row.replayUntil > now)) return false;
  if (family) await signOutFamily(db, row.userId, family, now);
  return true;
}
// The client that holds a refresh token, if it is one. The revoke hook (auth.ts) uses it to keep a client from
// revoking, or triggering family revocation with, another client's token.
export async function refreshTokenClient(db: Database, token: string) {
  const [row] = await db
    .select({ clientId: schema.oauthRefreshToken.clientId })
    .from(schema.oauthRefreshToken)
    .where(eq(schema.oauthRefreshToken.token, hashToken(token)));
  return row?.clientId ?? null;
}

// Names the browser from its User-Agent for the account page. Brave and Arc report Chrome.
export function browserOf(userAgent: string | undefined): {
  browser: ConnectedBrowser['browser'];
  platform: ConnectedBrowser['platform'];
} {
  const agent = userAgent ?? '';
  const browser = /\bEdg\//.test(agent)
    ? 'edge'
    : /\bOPR\//.test(agent)
      ? 'opera'
      : /\bChrome\//.test(agent)
        ? 'chrome'
        : null;
  const platform = /\bMacintosh\b/.test(agent)
    ? 'macos'
    : /\bWindows\b/.test(agent)
      ? 'windows'
      : /\bCrOS\b/.test(agent)
        ? 'chromeos'
        : /\bLinux\b/.test(agent)
          ? 'linux'
          : null;
  return { browser, platform };
}
