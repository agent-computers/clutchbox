import 'server-only';
import { createHash } from 'node:crypto';
import { extensionClientId, refreshReuseSeconds, syncScope } from '@agent-computers/capture';
import { and, asc, eq, exists, gt, isNotNull, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { deleteCapturesIn, lockMember, type Transaction } from './captures';
import type { Database } from './database';
import { newPublicId, publicIdPattern } from './ids';
import { currentMember, type Member } from './organizations';
import * as schema from './schema';

// Browsers connected with OAuth. The extension is a first-party client of our Better Auth server whose
// opaque `sync` tokens work only on the extension's routes. A connected browser is one refresh-token family: the
// authorization code it started from (authorization_code_id), which every rotation carries over. It syncs to the
// membership the person was acting in when it connected (organizations.ts, currentMember), and only to that one.

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
    client_name: 'Agent Computers extension',
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
  // The browser's membership, which its uploads and settings belong to.
  member: Member;
};
// The account, browser, and membership behind a sync token, or null. Checks the token row itself (unrevoked, unexpired, the sync
// scope), the account (verified, not banned), the client (enabled), and the browser (not disconnected). The web
// session is never consulted: a browser syncs to the account that connected it until it is disconnected.
export async function syncPrincipal(
  db: Database,
  {
    authorization,
    userAgent,
    now = new Date(),
  }: { authorization: string | undefined; userAgent?: string | undefined; now?: Date },
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
  const [row] = await db
    .select({
      id: schema.connectedBrowsers.id,
      publicId: schema.connectedBrowsers.publicId,
      userId: schema.memberships.userId,
      disconnectedAt: schema.connectedBrowsers.disconnectedAt,
      membershipId: schema.memberships.id,
      organizationId: schema.memberships.organizationId,
    })
    .from(schema.connectedBrowsers)
    .innerJoin(schema.memberships, eq(schema.memberships.id, schema.connectedBrowsers.membershipId))
    .where(eq(schema.connectedBrowsers.authorizationCodeId, family));
  if (!row || row.userId !== found.userId || row.disconnectedAt) return null;
  await pruneFamily(db, found.userId, family, now);
  return {
    id: found.userId,
    name: found.name,
    email: found.email,
    browser: { id: row.id, publicId: row.publicId },
    member: { userId: found.userId, membershipId: row.membershipId, organizationId: row.organizationId },
  };
}
// Records a family's browser, in the person's current membership. Never overwrites, so a tombstone always wins. An
// account the tenancy has not placed yet records none, so its browser cannot sync until the next migration run places
// it.
async function recordFamily(db: Database, userId: string, family: string, userAgent: string | undefined, now: Date) {
  const member = await currentMember(db, userId);
  if (!member) return;
  await db
    .insert(schema.connectedBrowsers)
    .values({
      publicId: newPublicId('browser', now.getTime()),
      membershipId: member.membershipId,
      authorizationCodeId: family,
      ...browserOf(userAgent),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: schema.connectedBrowsers.authorizationCodeId });
}
// Records the browser behind a freshly issued sync token. The token endpoint's after-hook (auth.ts) calls it, so a
// browser is listed, and can be disconnected, from its code exchange on.
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

// The member whose browsers these are, with the person: Better Auth keys the extension's tokens by user.
type Owner = Pick<Member, 'userId' | 'membershipId'>;
export type ConnectedBrowser = {
  id: string;
  browser: (typeof schema.BROWSER_NAMES)[number] | null;
  platform: (typeof schema.BROWSER_PLATFORMS)[number] | null;
  connectedAt: Date;
  lastSyncedAt: Date | null;
};
// The member's connected browsers: not disconnected, and still holding a live refresh token.
export async function listBrowsers(db: Database, member: Owner, now = new Date()): Promise<ConnectedBrowser[]> {
  const { userId } = member;
  const browsers = schema.connectedBrowsers;
  const refresh = schema.oauthRefreshToken;
  return db
    .select({
      id: browsers.publicId,
      browser: browsers.browser,
      platform: browsers.platform,
      connectedAt: browsers.createdAt,
      lastSyncedAt: browsers.lastSyncedAt,
    })
    .from(browsers)
    .where(
      and(
        eq(browsers.membershipId, member.membershipId),
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

// Tombstones one family of the member's, deletes its tokens, and deletes the capture if this browser sent it. Holds
// lockMember.
async function disconnectFamily(tx: Transaction, member: Owner, family: string, now: Date) {
  const { userId } = member;
  const [row] = await tx
    .insert(schema.connectedBrowsers)
    .values({
      publicId: newPublicId('browser', now.getTime()),
      membershipId: member.membershipId,
      authorizationCodeId: family,
      disconnectedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.connectedBrowsers.authorizationCodeId,
      set: {
        disconnectedAt: sql`coalesce(${schema.connectedBrowsers.disconnectedAt}, ${now})`,
        browser: null,
        platform: null,
        lastSyncedAt: null,
      },
      setWhere: eq(schema.connectedBrowsers.membershipId, member.membershipId),
    })
    .returning({ id: schema.connectedBrowsers.id });
  if (!row) return;
  for (const table of [schema.oauthAccessToken, schema.oauthRefreshToken])
    await tx.delete(table).where(and(extensionTokens(table, userId), eq(table.authorizationCodeId, family)));
  await deleteCapturesIn(tx, member, { uploadedBy: row.id });
}
// One of the member's browsers, by its public ID (the account page) or row ID (the browser itself). False when it is
// not theirs or already disconnected.
export async function disconnectBrowser(db: Database, member: Owner, which: { publicId: string } | { id: number }) {
  return db.transaction(async tx => {
    await lockMember(tx, member);
    const browsers = schema.connectedBrowsers;
    const [row] = await tx
      .select({ family: browsers.authorizationCodeId })
      .from(browsers)
      .where(
        and(
          eq(browsers.membershipId, member.membershipId),
          isNull(browsers.disconnectedAt),
          'publicId' in which ? eq(browsers.publicId, which.publicId) : eq(browsers.id, which.id),
        ),
      );
    if (!row) return false;
    await disconnectFamily(tx, member, row.family, new Date());
    return true;
  });
}
// Every browser of the member's, used or not: tombstones each family and deletes its extension tokens, and every
// extension code not yet exchanged, so a browser mid-connect cannot connect afterwards. Browsers the person connected
// to their other memberships stay. Captures are the caller's.
export async function disconnectAllBrowsers(db: Database, member: Owner) {
  const { userId } = member;
  await db.transaction(async tx => {
    await lockMember(tx, member);
    const now = new Date();
    const browsers = schema.connectedBrowsers;
    const refresh = schema.oauthRefreshToken;
    // Families recorded in the person's other memberships; a family with no record yet counts as this member's.
    const elsewhere = tx
      .select({ family: browsers.authorizationCodeId })
      .from(browsers)
      .innerJoin(schema.memberships, eq(schema.memberships.id, browsers.membershipId))
      .where(and(eq(schema.memberships.userId, userId), ne(browsers.membershipId, member.membershipId)));
    const mine = <T extends typeof schema.oauthAccessToken | typeof schema.oauthRefreshToken>(table: T) =>
      and(
        extensionTokens(table, userId),
        or(isNull(table.authorizationCodeId), notInArray(table.authorizationCodeId, elsewhere)),
      );
    // Better Auth stores a code as JSON.stringify({ type: 'authorization_code', query, userId, ... }); the CASE casts
    // only values with that prefix, so other verification values never reach the cast.
    const { value } = schema.verification;
    const pending = JSON.stringify({ userId, query: { client_id: EXTENSION_CLIENT_ID } });
    await tx
      .delete(schema.verification)
      .where(
        sql`case when ${value} like '{"type":"authorization_code",%' then ${value}::jsonb @> ${pending}::jsonb else false end`,
      );
    const families = await tx
      .selectDistinct({ family: refresh.authorizationCodeId })
      .from(refresh)
      .where(and(mine(refresh), isNotNull(refresh.authorizationCodeId)));
    const cleared = { browser: null, platform: null, lastSyncedAt: null };
    if (families.length)
      await tx
        .insert(browsers)
        .values(
          families.map(({ family }) => ({
            publicId: newPublicId('browser', now.getTime()),
            membershipId: member.membershipId,
            authorizationCodeId: family!,
            disconnectedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: browsers.authorizationCodeId,
          set: { disconnectedAt: sql`coalesce(${browsers.disconnectedAt}, ${now})`, ...cleared },
          setWhere: eq(browsers.membershipId, member.membershipId),
        });
    await tx
      .update(browsers)
      .set({ disconnectedAt: now, ...cleared })
      .where(and(eq(browsers.membershipId, member.membershipId), isNull(browsers.disconnectedAt)));
    await tx.delete(schema.oauthAccessToken).where(mine(schema.oauthAccessToken));
    await tx.delete(refresh).where(mine(refresh));
  });
}

// Refresh-token theft, one browser at a time. Before Better Auth sees an extension refresh, true refuses it: the
// family is disconnected, or the token was rotated more than the reuse window ago, which disconnects only this family.
// Better Auth would instead delete every family of the client for the user, so one replay would disconnect every
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
  let membershipId: number | null = null;
  if (family) {
    const [browser] = await db
      .select({
        disconnectedAt: schema.connectedBrowsers.disconnectedAt,
        membershipId: schema.connectedBrowsers.membershipId,
      })
      .from(schema.connectedBrowsers)
      .where(eq(schema.connectedBrowsers.authorizationCodeId, family));
    if (browser?.disconnectedAt) return true;
    membershipId = browser?.membershipId ?? null;
  }
  if (!row.revoked || (row.replayUntil && row.replayUntil > now)) return false;
  // The browser's membership, or for a family with no record yet, the one it would have been recorded in.
  membershipId ??= (await currentMember(db, row.userId))?.membershipId ?? null;
  if (family && membershipId !== null) {
    const member = { userId: row.userId, membershipId };
    await db.transaction(async tx => {
      await lockMember(tx, member);
      await disconnectFamily(tx, member, family, now);
    });
  }
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
