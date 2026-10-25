import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { and, eq, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from './auth';
import {
  authorizeBrowser,
  CHROME_ON_MAC,
  connectBrowser,
  EDGE_ON_WINDOWS,
  refreshBrowser,
  type Tokens,
  tokenRequest,
} from './browser-fixtures';
import {
  browserOf,
  disconnectAllBrowsers,
  disconnectBrowser,
  EXTENSION_CLIENT_ID,
  ensureExtensionClient,
  listBrowsers,
  syncPrincipal,
} from './browsers';
import { bundle, cookie } from './capture-fixtures';
import { saveCapture } from './captures';
import type { ServerConfig } from './config';
import type { Database } from './database';
import * as schema from './schema';

const origin = 'http://localhost:3097';
const extension = `chrome-extension://${'a'.repeat(32)}`;
const config: ServerConfig = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/synthetic',
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'synthetic-only',
};
let pg: PGlite;
let db: Database;
let auth: ReturnType<typeof createAuth>;
async function identity(id: string) {
  await db.insert(schema.user).values({ id, name: `Fixture ${id}`, email: `${id}@example.test`, emailVerified: true });
  const token = randomBytes(32).toString('base64url');
  await db
    .insert(schema.session)
    .values({ id: randomUUID(), userId: id, token, expiresAt: new Date(Date.now() + 3600_000) });
  const signature = createHmac('sha256', config.BETTER_AUTH_SECRET).update(token).digest('base64');
  return `${(await auth.$context).authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
}
const hash = (token: string) => createHash('sha256').update(token).digest('base64url');
const principal = (tokens: Pick<Tokens, 'access_token'>, userAgent = CHROME_ON_MAC, now?: Date) =>
  syncPrincipal(db, { authorization: `Bearer ${tokens.access_token}`, userAgent, ...(now ? { now } : {}) });
const connect = (cookie: string, userAgent?: string) =>
  connectBrowser(auth, cookie, { extensionOrigin: extension, ...(userAgent ? { userAgent } : {}) });
const refresh = (token: string, extra = {}) => refreshBrowser(auth, extension, token, extra);
const familyOf = async (accessToken: string) =>
  (
    await db
      .select({ family: schema.oauthAccessToken.authorizationCodeId })
      .from(schema.oauthAccessToken)
      .where(eq(schema.oauthAccessToken.token, hash(accessToken)))
  )[0]!.family!;
// An OAuth error that the provider answers on the redirect URI.
const redirectError = (response: Response) => new URL(response.headers.get('location')!).searchParams.get('error');
// A synthetic agent client with a consent and tokens, which browser disconnects must leave alone.
async function agentGrant(userId: string) {
  await db
    .insert(schema.oauthClient)
    .values({ id: 'agent', clientId: 'agent', redirectUris: [] })
    .onConflictDoNothing();
  const now = new Date();
  await db.insert(schema.oauthConsent).values({
    id: randomUUID(),
    clientId: 'agent',
    userId,
    scopes: ['offline_access', 'mcp:tools'],
    createdAt: now,
    updatedAt: now,
  });
  const refreshId = randomUUID();
  const later = new Date(Date.now() + 3600_000);
  await db.insert(schema.oauthRefreshToken).values({
    id: refreshId,
    token: hash(randomUUID()),
    clientId: 'agent',
    userId,
    expiresAt: later,
    createdAt: now,
    scopes: ['offline_access', 'mcp:tools'],
  });
  const token = randomBytes(24).toString('base64url');
  await db.insert(schema.oauthAccessToken).values({
    id: randomUUID(),
    token: hash(token),
    clientId: 'agent',
    userId,
    refreshId,
    authorizationCodeId: randomUUID(),
    expiresAt: later,
    createdAt: now,
    scopes: ['sync'],
  });
  return token;
}
const agentRows = async () => ({
  consents: (await db.select().from(schema.oauthConsent)).length,
  access: (await db.select().from(schema.oauthAccessToken).where(eq(schema.oauthAccessToken.clientId, 'agent'))).length,
  refresh: (await db.select().from(schema.oauthRefreshToken).where(eq(schema.oauthRefreshToken.clientId, 'agent')))
    .length,
});

// Migrate once per file and give each test a clone, which is much faster than a new database.
let template: PGlite;
beforeAll(async () => {
  template = new PGlite();
  const templateDb = drizzle(template, { schema });
  await migrate(templateDb, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  await ensureExtensionClient(templateDb as unknown as Database, extension);
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  db = drizzle(pg, { schema }) as unknown as Database;
  auth = createAuth(db, config);
  await auth.$context;
  vi.stubEnv('CAPTURE_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await pg.close();
});

describe('extension OAuth client', () => {
  it('connects without a consent page and issues opaque sync tokens', async () => {
    const a = await identity('a');
    const tokens = await connect(a);
    expect(tokens.scope).toBe('offline_access sync');
    expect(tokens.access_token.split('.')).toHaveLength(1);
    const [row] = await db
      .select()
      .from(schema.oauthAccessToken)
      .where(eq(schema.oauthAccessToken.token, hash(tokens.access_token)));
    expect(row).toMatchObject({ clientId: EXTENSION_CLIENT_ID, userId: 'a', scopes: ['offline_access', 'sync'] });
    expect(await db.select().from(schema.oauthConsent)).toEqual([]);
    // Each refresh issues a refresh token with a fresh idle window, not the rest of the old one.
    const soon = new Date(Date.now() + 3600_000);
    await db
      .update(schema.oauthRefreshToken)
      .set({ expiresAt: soon })
      .where(eq(schema.oauthRefreshToken.token, hash(tokens.refresh_token)));
    const refreshed = (await (await refresh(tokens.refresh_token)).json()) as Tokens;
    const [next] = await db
      .select({ expiresAt: schema.oauthRefreshToken.expiresAt })
      .from(schema.oauthRefreshToken)
      .where(eq(schema.oauthRefreshToken.token, hash(refreshed.refresh_token)));
    expect(next!.expiresAt.getTime()).toBeGreaterThan(soon.getTime());
  });

  it("writes its client row idempotently from EXTENSION_ORIGINS, keeping an operator's disable", async () => {
    const other = `chrome-extension://${'b'.repeat(32)}`;
    const client = async () =>
      (await db.select().from(schema.oauthClient).where(eq(schema.oauthClient.id, EXTENSION_CLIENT_ID)))[0]!;
    await ensureExtensionClient(db, extension);
    expect(await db.select().from(schema.oauthClient)).toHaveLength(1);
    expect(await client()).toMatchObject({
      clientId: EXTENSION_CLIENT_ID,
      skipConsent: true,
      requirePKCE: true,
      tokenEndpointAuthMethod: 'none',
      scopes: ['offline_access', 'sync'],
      redirectUris: [`${extension}/connected.html`],
      disabled: false,
    });
    // Something else linked it to the MCP resource and turned it off; the next write unlinks it and keeps it off.
    await db
      .insert(schema.oauthResource)
      .values({ id: 'mcp', identifier: `${origin}/api/mcp`, name: 'MCP' })
      .onConflictDoNothing();
    const [resource] = await db.select().from(schema.oauthResource);
    await db
      .insert(schema.oauthClientResource)
      .values({ id: randomUUID(), clientId: EXTENSION_CLIENT_ID, resourceId: resource!.identifier });
    await db
      .update(schema.oauthClient)
      .set({ disabled: true, clientSecret: 'x', scopes: ['mcp:tools'] })
      .where(eq(schema.oauthClient.id, EXTENSION_CLIENT_ID));
    await ensureExtensionClient(db, `${extension}, ${other}, not-an-origin`);
    expect(await client()).toMatchObject({
      disabled: true,
      clientSecret: null,
      scopes: ['offline_access', 'sync'],
      redirectUris: [`${extension}/connected.html`, `${other}/connected.html`],
    });
    expect(await db.select().from(schema.oauthClientResource)).toEqual([]);
    await ensureExtensionClient(db, undefined);
    expect((await client()).redirectUris).toEqual([]);
  });

  it('refuses the MCP resource, agent scopes, a missing PKCE challenge, and a consent prompt', async () => {
    const a = await identity('a');
    const resource = `${origin}/api/mcp`;
    const authorize = (query: Record<string, string | undefined>) =>
      authorizeBrowser(auth, a, { extensionOrigin: extension, query });
    expect(redirectError((await authorize({ resource })).response)).toBe('invalid_target');
    expect(redirectError((await authorize({ scope: 'offline_access sync mcp:tools' })).response)).toBe('invalid_scope');
    expect(
      redirectError((await authorize({ code_challenge: undefined, code_challenge_method: undefined })).response),
    ).toBe('invalid_request');
    const consent = (await authorize({ prompt: 'consent' })).response;
    expect(consent.status).toBe(400);
    expect(await consent.json()).toMatchObject({ error: 'invalid_request' });
    // The same request as a form POST, whose parameters Better Auth reads from the body.
    const posted = await auth.handler(
      new Request(`${origin}/api/auth/oauth2/authorize`, {
        method: 'POST',
        headers: { origin, cookie: a, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: EXTENSION_CLIENT_ID,
          redirect_uri: `${extension}/connected.html`,
          response_type: 'code',
          scope: 'offline_access sync',
          code_challenge: hash(randomUUID()),
          code_challenge_method: 'S256',
          prompt: 'consent',
        }).toString(),
      }),
    );
    expect(posted.status).toBe(400);
    expect(await posted.json()).toMatchObject({ error: 'invalid_request' });
    expect(await db.select().from(schema.oauthConsent)).toEqual([]);
    // A code exchanged, or a token refreshed, for the MCP resource.
    const { response, verifier } = await authorize({});
    const code = new URL(response.headers.get('location')!).searchParams.get('code')!;
    const exchange = await tokenRequest(auth, extension, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: `${extension}/connected.html`,
      resource,
    });
    expect(exchange.status).toBe(400);
    expect((await exchange.json()).error).toBe('invalid_target');
    const tokens = await connect(a);
    const refused = await refresh(tokens.refresh_token, { resource });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe('invalid_target');
  });
});

describe('sync tokens', () => {
  it('name the account and its browser, across refreshes', async () => {
    const a = await identity('a');
    const first = await connect(a);
    const now = new Date();
    const found = await principal(first);
    expect(found).toMatchObject({ id: 'a', name: 'Fixture a', email: 'a@example.test' });
    expect(found!.browser.publicId).toMatch(/^brw_/);
    expect(await principal(first, EDGE_ON_WINDOWS)).toEqual(found);
    const refreshed = await refresh(first.refresh_token);
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as Tokens;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await principal(second)).toEqual(found);
    expect(await db.select().from(schema.connectedBrowsers)).toHaveLength(1);
    const listed = await listBrowsers(db, 'a');
    expect(listed).toEqual([
      {
        id: found!.browser.publicId,
        browser: 'chrome',
        platform: 'macos',
        connectedAt: expect.any(Date),
        lastSyncedAt: null,
      },
    ]);
    expect(Math.abs(listed[0]!.connectedAt.getTime() - now.getTime())).toBeLessThan(5000);
    expect(browserOf(EDGE_ON_WINDOWS)).toEqual({ browser: 'edge', platform: 'windows' });
    expect(browserOf('curl/8.0')).toEqual({ browser: null, platform: null });
    expect(browserOf(undefined)).toEqual({ browser: null, platform: null });
  });

  it("are refused when expired, revoked, another client's, without sync, for a locked-out account, a disabled client, or malformed", async () => {
    const a = await identity('a');
    const tokens = await connect(a);
    const later = new Date(Date.now() + 301_000);
    expect(await principal(tokens, CHROME_ON_MAC, later)).toBeNull();
    expect(await principal(tokens)).not.toBeNull();
    for (const authorization of [
      undefined,
      '',
      tokens.access_token,
      `Basic ${tokens.access_token}`,
      'Bearer a b',
      `Bearer ${'a'.repeat(513)}`,
    ])
      expect(await syncPrincipal(db, { authorization }), String(authorization)).toBeNull();
    expect(await syncPrincipal(db, { authorization: `bearer  ${tokens.access_token}` })).not.toBeNull();
    const row = eq(schema.oauthAccessToken.token, hash(tokens.access_token));
    // Not the extension's, or without the sync scope.
    await db
      .insert(schema.oauthClient)
      .values({ id: 'agent', clientId: 'agent', redirectUris: [] })
      .onConflictDoNothing();
    await db.update(schema.oauthAccessToken).set({ clientId: 'agent' }).where(row);
    expect(await principal(tokens)).toBeNull();
    await db
      .update(schema.oauthAccessToken)
      .set({ clientId: EXTENSION_CLIENT_ID, scopes: ['offline_access'] })
      .where(row);
    expect(await principal(tokens)).toBeNull();
    await db
      .update(schema.oauthAccessToken)
      .set({ scopes: ['offline_access', 'sync'] })
      .where(row);
    expect(await principal(tokens)).not.toBeNull();
    // The account and client.
    await db.update(schema.user).set({ emailVerified: false });
    expect(await principal(tokens)).toBeNull();
    await db.update(schema.user).set({ emailVerified: true, banned: true });
    expect(await principal(tokens)).toBeNull();
    await db.update(schema.user).set({ banExpires: new Date(Date.now() - 1000) });
    expect(await principal(tokens)).not.toBeNull();
    await db.update(schema.oauthClient).set({ disabled: true }).where(eq(schema.oauthClient.id, EXTENSION_CLIENT_ID));
    expect(await principal(tokens)).toBeNull();
    await db.update(schema.oauthClient).set({ disabled: false }).where(eq(schema.oauthClient.id, EXTENSION_CLIENT_ID));
    await db.update(schema.oauthAccessToken).set({ revoked: new Date() }).where(row);
    expect(await principal(tokens)).toBeNull();
  });

  it('outlive web sign-out through a refresh', async () => {
    const a = await identity('a');
    const tokens = await connect(a);
    expect(await principal(tokens)).not.toBeNull();
    const signOut = await auth.handler(
      new Request(`${origin}/api/auth/sign-out`, {
        method: 'POST',
        headers: { origin, cookie: a, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(signOut.status).toBe(200);
    await vi.waitFor(async () => expect(await principal(tokens)).toBeNull());
    const refreshed = await refresh(tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    expect(await principal((await refreshed.json()) as Tokens)).toMatchObject({ id: 'a' });
    expect(await listBrowsers(db, 'a')).toHaveLength(1);
  });

  it("prune their family's expired tokens and keep live and rotated ones", async () => {
    const a = await identity('a');
    const first = await connect(a);
    const second = (await (await refresh(first.refresh_token)).json()) as Tokens;
    const family = await familyOf(second.access_token);
    const now = new Date();
    const past = new Date(now.getTime() - 1000);
    // The first access token expired; an extra rotated refresh token expired too.
    await db
      .update(schema.oauthAccessToken)
      .set({ expiresAt: past })
      .where(eq(schema.oauthAccessToken.token, hash(first.access_token)));
    const expiredId = randomUUID();
    await db.insert(schema.oauthRefreshToken).values({
      id: expiredId,
      token: hash(randomUUID()),
      clientId: EXTENSION_CLIENT_ID,
      userId: 'a',
      authorizationCodeId: family,
      expiresAt: past,
      createdAt: past,
      revoked: past,
      scopes: ['offline_access', 'sync'],
    });
    expect(await principal(second, CHROME_ON_MAC, now)).not.toBeNull();
    const access = await db.select().from(schema.oauthAccessToken);
    expect(access.map(row => row.token)).toEqual([hash(second.access_token)]);
    const refreshRows = await db.select().from(schema.oauthRefreshToken);
    expect(refreshRows.map(row => row.token).sort()).toEqual(
      [hash(first.refresh_token), hash(second.refresh_token)].sort(),
    );
  });
});

describe('connected browsers', () => {
  it('list only live, unrevoked browsers of the account', async () => {
    const a = await identity('a');
    const b = await identity('b');
    const used = await connect(a);
    await principal(used);
    const expiring = await connect(a, EDGE_ON_WINDOWS);
    await connect(b);
    expect((await listBrowsers(db, 'a')).map(row => row.browser)).toEqual(['chrome', 'edge']);
    // The refresh token expired, or was deleted.
    await db
      .update(schema.oauthRefreshToken)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.oauthRefreshToken.token, hash(expiring.refresh_token)));
    expect((await listBrowsers(db, 'a')).map(row => row.browser)).toEqual(['chrome']);
    await db.delete(schema.oauthRefreshToken).where(eq(schema.oauthRefreshToken.token, hash(used.refresh_token)));
    expect(await listBrowsers(db, 'a')).toEqual([]);
    expect(await listBrowsers(db, 'b')).toHaveLength(1);
  });

  it('are recorded at the code exchange, so one that never made a request can be disconnected', async () => {
    const a = await identity('a');
    const tokens = await connect(a, EDGE_ON_WINDOWS);
    const [listed] = await listBrowsers(db, 'a');
    expect(listed).toMatchObject({ browser: 'edge', platform: 'windows', lastSyncedAt: null });
    // Its first request finds the same browser.
    expect((await principal(tokens))!.browser.publicId).toBe(listed!.id);
    expect(await db.select().from(schema.connectedBrowsers)).toHaveLength(1);
    expect(await disconnectBrowser(db, 'a', { publicId: listed!.id })).toBe(true);
    expect(await principal(tokens)).toBeNull();
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
    expect(await listBrowsers(db, 'a')).toEqual([]);
  });

  it('disconnect one at a time, deleting the capture only when that browser sent it', async () => {
    const a = await identity('a');
    await identity('b');
    const one = await connect(a);
    const two = await connect(a, EDGE_ON_WINDOWS);
    const first = (await principal(one))!;
    const second = (await principal(two))!;
    const agent = await agentGrant('a');
    expect(await saveCapture(db, 'a', bundle([cookie()]), { browser: second.browser.id })).toMatchObject({
      status: 'stored',
    });
    // Another account, or an unknown ID: nothing happens.
    expect(await disconnectBrowser(db, 'b', { publicId: first.browser.publicId })).toBe(false);
    expect(await disconnectBrowser(db, 'a', { publicId: 'brw_00000000000000000000000000' })).toBe(false);
    // The first did not send the capture, so it stays.
    expect(await disconnectBrowser(db, 'a', { publicId: first.browser.publicId })).toBe(true);
    expect(await disconnectBrowser(db, 'a', { publicId: first.browser.publicId })).toBe(false);
    expect(await db.select().from(schema.captures)).toHaveLength(1);
    expect(await db.select().from(schema.syncRevocations)).toEqual([]);
    expect(await principal(one)).toBeNull();
    expect((await refresh(one.refresh_token)).status).toBe(400);
    expect(await principal(two)).not.toBeNull();
    expect((await listBrowsers(db, 'a')).map(row => row.id)).toEqual([second.browser.publicId]);
    const [tombstone] = await db
      .select()
      .from(schema.connectedBrowsers)
      .where(eq(schema.connectedBrowsers.id, first.browser.id));
    expect(tombstone).toMatchObject({
      browser: null,
      platform: null,
      lastSyncedAt: null,
      disconnectedAt: expect.any(Date),
    });
    // The second did: its capture goes, behind a deletion tombstone.
    expect(await disconnectBrowser(db, 'a', { id: second.browser.id })).toBe(true);
    expect(await db.select().from(schema.captures)).toEqual([]);
    expect(await db.select().from(schema.syncRevocations)).toMatchObject([{ userId: 'a', disconnected: false }]);
    expect((await refresh(two.refresh_token)).status).toBe(400);
    expect(await agentRows()).toEqual({ consents: 1, access: 1, refresh: 1 });
    // Another client's token is never a sync token, even with the scope.
    expect(await syncPrincipal(db, { authorization: `Bearer ${agent}` })).toBeNull();
  });

  it('disconnect all at once, used or not, leaving agents alone', async () => {
    const a = await identity('a');
    const b = await identity('b');
    const used = await connect(a);
    await principal(used);
    const unused = await connect(a);
    const theirs = await connect(b);
    await principal(theirs);
    await agentGrant('a');
    await disconnectAllBrowsers(db, 'a');
    expect(await listBrowsers(db, 'a')).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.oauthRefreshToken)
        .where(
          and(eq(schema.oauthRefreshToken.userId, 'a'), eq(schema.oauthRefreshToken.clientId, EXTENSION_CLIENT_ID)),
        ),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.connectedBrowsers)
        .where(and(eq(schema.connectedBrowsers.userId, 'a'), isNotNull(schema.connectedBrowsers.disconnectedAt))),
    ).toHaveLength(2);
    for (const tokens of [used, unused]) {
      expect(await principal(tokens)).toBeNull();
      expect((await refresh(tokens.refresh_token)).status).toBe(400);
    }
    expect(await principal(theirs)).not.toBeNull();
    expect(await agentRows()).toEqual({ consents: 1, access: 1, refresh: 1 });
  });

  it('disconnect all at once, including a browser mid-connect whose code is not yet exchanged', async () => {
    const a = await identity('a');
    const b = await identity('b');
    const pending = async (cookie: string) => {
      const { response, verifier } = await authorizeBrowser(auth, cookie, { extensionOrigin: extension });
      const code = new URL(response.headers.get('location')!).searchParams.get('code')!;
      return () =>
        tokenRequest(auth, extension, {
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: `${extension}/connected.html`,
        });
    };
    const mine = await pending(a);
    const theirs = await pending(b);
    await disconnectAllBrowsers(db, 'a');
    const refused = await mine();
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe('invalid_grant');
    expect(await listBrowsers(db, 'a')).toEqual([]);
    expect((await theirs()).status).toBe(200);
    expect(await listBrowsers(db, 'b')).toHaveLength(1);
  });

  it('stay disconnected when a racing rotation recreates their tokens', async () => {
    const a = await identity('a');
    const tokens = await connect(a);
    const found = (await principal(tokens))!;
    const family = await familyOf(tokens.access_token);
    await disconnectBrowser(db, 'a', { id: found.browser.id });
    // A rotation that read the old row before the disconnect writes its new tokens after it.
    const refreshToken = randomBytes(24).toString('base64url');
    const accessToken = randomBytes(24).toString('base64url');
    const refreshId = randomUUID();
    const now = new Date();
    const later = new Date(now.getTime() + 3600_000);
    await db.insert(schema.oauthRefreshToken).values({
      id: refreshId,
      token: hash(refreshToken),
      clientId: EXTENSION_CLIENT_ID,
      userId: 'a',
      authorizationCodeId: family,
      expiresAt: later,
      createdAt: now,
      scopes: ['offline_access', 'sync'],
    });
    await db.insert(schema.oauthAccessToken).values({
      id: randomUUID(),
      token: hash(accessToken),
      clientId: EXTENSION_CLIENT_ID,
      userId: 'a',
      authorizationCodeId: family,
      refreshId,
      expiresAt: later,
      createdAt: now,
      scopes: ['offline_access', 'sync'],
    });
    expect(await principal({ access_token: accessToken })).toBeNull();
    expect(await listBrowsers(db, 'a')).toEqual([]);
    const refused = await refresh(refreshToken);
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe('invalid_grant');
  });

  it('disconnect only the browser whose rotated refresh token is replayed after the reuse window', async () => {
    const a = await identity('a');
    const one = await connect(a);
    const two = await connect(a);
    await principal(one);
    await principal(two);
    const rotated = (await (await refresh(one.refresh_token)).json()) as Tokens;
    // Within the window, a retry gets the same answer.
    const retried = await refresh(one.refresh_token);
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as Tokens).refresh_token).toBe(rotated.refresh_token);
    // Past it, the replay disconnects that browser only.
    await db
      .update(schema.oauthRefreshToken)
      .set({ rotationReplayExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.oauthRefreshToken.token, hash(one.refresh_token)));
    const replayed = await refresh(one.refresh_token);
    expect(replayed.status).toBe(400);
    expect((await replayed.json()).error).toBe('invalid_grant');
    expect(await principal(rotated)).toBeNull();
    expect((await refresh(rotated.refresh_token)).status).toBe(400);
    expect(await listBrowsers(db, 'a')).toHaveLength(1);
    expect((await refresh(two.refresh_token)).status).toBe(200);
  });

  it("cannot be revoked through /oauth2/revoke, nor disconnected by another client's stale token", async () => {
    const a = await identity('a');
    const tokens = await connect(a);
    await principal(tokens);
    // The client names itself with client_id in the body, or with HTTP Basic.
    const revoke = (body: Record<string, string>, basic?: string) =>
      auth.handler(
        new Request(`${origin}/api/auth/oauth2/revoke`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            ...(basic ? { authorization: `Basic ${Buffer.from(basic).toString('base64')}` } : {}),
          },
          body: new URLSearchParams(body).toString(),
        }),
      );
    for (const refused of [
      await revoke({ client_id: EXTENSION_CLIENT_ID, token: tokens.refresh_token }),
      await revoke({ token: tokens.refresh_token }, `${encodeURIComponent(EXTENSION_CLIENT_ID)}:x`),
    ]) {
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toBe('unauthorized_client');
    }
    // An agent's rotated refresh token, presented as the extension or as another agent.
    await db.insert(schema.oauthClient).values([
      { id: 'agent', clientId: 'agent', redirectUris: [], tokenEndpointAuthMethod: 'none' },
      { id: 'other', clientId: 'other', redirectUris: [], tokenEndpointAuthMethod: 'none' },
    ]);
    const stale = randomBytes(24).toString('base64url');
    const now = new Date();
    const row = (clientId: string, token: string, revoked: Date | null) => ({
      id: randomUUID(),
      token: hash(token),
      clientId,
      userId: 'a',
      expiresAt: new Date(now.getTime() + 3600_000),
      createdAt: now,
      revoked,
      rotatedAt: revoked,
      scopes: ['offline_access', 'mcp:tools'],
    });
    await db.insert(schema.oauthRefreshToken).values([row('agent', stale, now), row('other', randomUUID(), null)]);
    for (const client_id of [EXTENSION_CLIENT_ID, 'other'])
      await revoke({ client_id, token: stale, token_type_hint: 'refresh_token' });
    const answered = await revoke({ client_id: 'other', token: stale });
    expect(answered.status).toBe(200);
    expect((await revoke({ token: stale }, 'other:x')).status).toBe(200);
    // A Basic client ID that is not valid percent-encoding names no client.
    expect((await revoke({ token: stale }, '%E0%A4%A:x')).status).toBeLessThan(500);
    // The other agent's own token survives too.
    expect(
      await db.select().from(schema.oauthRefreshToken).where(eq(schema.oauthRefreshToken.clientId, 'other')),
    ).toHaveLength(1);
    expect(await principal(tokens)).not.toBeNull();
    expect(await listBrowsers(db, 'a')).toHaveLength(1);
    expect((await refresh(tokens.refresh_token)).status).toBe(200);
  });

  it('leave skip_consent to the extension client alone', async () => {
    await db.insert(schema.oauthClient).values({ id: 'agent', clientId: 'agent', redirectUris: [] });
    await expect(
      db.update(schema.oauthClient).set({ skipConsent: true }).where(eq(schema.oauthClient.id, 'agent')),
    ).rejects.toThrow();
  });
});
