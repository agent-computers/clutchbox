import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  authorizeUrl,
  issuerOf,
  newState,
  pkce,
  readRedirect,
  requestTokens,
  type TokenResult,
} from '@agent-computers/capture';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../../server/src/auth';
import { CHROME_ON_MAC, connectBrowser, EDGE_ON_WINDOWS, type Tokens } from '../../server/src/browser-fixtures';
import { ensureExtensionClient } from '../../server/src/browsers';
import { bundle, cookie } from '../../server/src/capture-fixtures';
import type { ServerConfig } from '../../server/src/config';
import type { Database } from '../../server/src/database';
import { fakeComputerProvider } from '../../server/src/fake-computer-provider';
import { singleOrganization } from '../../server/src/organizations';
import * as schema from '../../server/src/schema';
import { createApi } from './index';
import { extensionCors, tokenPreflight } from './origins';

// The extension's OAuth connection over HTTP: CORS, bearer auth on its routes only, the origin guard, and
// the account page's Browsers routes. The token and family rules are tested in packages/server/src/browsers.test.ts.
const origin = 'http://localhost:3096';
const extension = `chrome-extension://${'a'.repeat(32)}`;
const unpinned = `chrome-extension://${'b'.repeat(32)}`;
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
  const person = { id, name: `Fixture ${id}`, email: `${id}@example.test` };
  await db.insert(schema.user).values({ ...person, emailVerified: true });
  // Into the deployment's organization, as sign-up does.
  await db.transaction(tx => singleOrganization.join(tx, person));
  const token = randomBytes(32).toString('base64url');
  await db
    .insert(schema.session)
    .values({ id: randomUUID(), userId: id, token, expiresAt: new Date(Date.now() + 3600_000) });
  const signature = createHmac('sha256', config.BETTER_AUTH_SECRET).update(token).digest('base64');
  return `${(await auth.$context).authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
}
type Options = {
  cookie?: string;
  token?: string | Tokens;
  from?: string | null;
  body?: unknown;
  version?: string;
  headers?: Record<string, string>;
};
function request(
  method: string,
  path: string,
  { cookie, token, from = extension, body, version, headers }: Options = {},
) {
  const api = createApi({ db, auth, origin, computers: fakeComputerProvider().provider });
  const bearer = typeof token === 'string' ? token : token?.access_token;
  return api.request(`${origin}/api/v1${path}`, {
    method,
    headers: {
      'user-agent': CHROME_ON_MAC,
      ...(cookie ? { cookie } : {}),
      ...(bearer !== undefined ? { authorization: `Bearer ${bearer}` } : {}),
      ...(version ? { 'x-extension-version': version } : {}),
      ...(from ? { origin: from } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const connect = (cookie: string, userAgent?: string) =>
  connectBrowser(auth, cookie, { extensionOrigin: extension, ...(userAgent ? { userAgent } : {}) });
const json = async (response: Response) => ({ status: response.status, body: await response.json() });
const browsers = async (cookie: string) =>
  (await (await request('GET', '/browsers', { cookie, from: origin })).json()).browsers as { id: string }[];
const local = { sites: ['github.com'], excludedDomains: [], paused: false };

// Migrate once per file and give each test a clone, which is much faster than a new database.
let template: PGlite;
beforeAll(async () => {
  template = new PGlite();
  const templateDb = drizzle(template, { schema });
  await migrate(templateDb, { migrationsFolder: fileURLToPath(new URL('../../server/migrations', import.meta.url)) });
  await ensureExtensionClient(templateDb as unknown as Database, extension);
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  db = drizzle(pg, { schema }) as unknown as Database;
  await db.insert(schema.installation).values({ dataClass: 'nonproduction' });
  auth = createAuth(db, config);
  await auth.$context;
  vi.stubEnv('CAPTURE_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('EXTENSION_ORIGINS', extension);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await pg.close();
});

describe('extension routes over OAuth', () => {
  it('answer CORS preflights for the pinned extension on its routes only', async () => {
    const preflight = (path: string, from: string) =>
      request('OPTIONS', path, {
        from,
        headers: {
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type,x-extension-version',
        },
      });
    for (const path of ['/me', '/captures', '/sync', '/sync/adopt']) {
      const allowed = await preflight(path, extension);
      expect(allowed.status, path).toBe(204);
      expect(allowed.headers.get('access-control-allow-origin'), path).toBe(extension);
      expect(allowed.headers.get('access-control-allow-headers')?.split(','), path).toEqual(
        expect.arrayContaining(['authorization', 'content-type', 'x-extension-version']),
      );
      expect(allowed.headers.get('access-control-allow-credentials'), path).toBeNull();
      expect(allowed.headers.get('vary'), path).toContain('Origin');
      for (const from of [unpinned, origin, 'https://evil.test'])
        expect((await preflight(path, from)).headers.get('access-control-allow-origin'), `${path} ${from}`).toBeNull();
    }
    for (const path of ['/computer', '/sync/disconnect', '/browsers']) {
      const refused = await preflight(path, extension);
      expect(refused.status, path).toBe(401);
      expect(refused.headers.get('access-control-allow-origin'), path).toBeNull();
    }
  });

  it('take a sync token on the extension routes, with CORS on every answer', async () => {
    const a = await identity('a');
    const tokens = await connect(a);
    const me = await request('GET', '/me', { token: tokens });
    expect(await json(me)).toEqual({
      status: 200,
      body: { user: { id: 'a', name: 'Fixture a', email: 'a@example.test' } },
    });
    expect(me.headers.get('access-control-allow-origin')).toBe(extension);
    expect(me.headers.get('set-cookie')).toBeNull();
    expect((await request('GET', '/sync', { token: tokens })).status).toBe(200);
    expect(await json(await request('POST', '/sync/adopt', { token: tokens, body: { settings: local } }))).toEqual({
      status: 200,
      body: { settings: local },
    });
    expect(
      (await json(await request('PATCH', '/sync', { token: tokens, body: { addSites: ['notion.so'], paused: false } })))
        .body.settings.sites,
    ).toEqual(['github.com', 'notion.so']);
    const uploaded = await request('POST', '/captures', {
      token: tokens,
      body: { capture: bundle([cookie({ domain: 'github.com' })]) },
    });
    expect(uploaded.status).toBe(200);
    expect(uploaded.headers.get('access-control-allow-origin')).toBe(extension);
    const [row] = await db.select().from(schema.connectedBrowsers);
    expect(row!.lastSyncedAt).toBeInstanceOf(Date);
    const [stored] = await db.select().from(schema.captures);
    expect(stored!.connectedBrowserId).toBe(row!.id);
    const refused = await request('GET', '/me', { token: 'not-a-live-token' });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(refused.headers.get('access-control-allow-origin')).toBe(extension);
    // The version gate still applies.
    const strict = createApi({
      db,
      auth,
      origin,
      computers: fakeComputerProvider().provider,
      minExtensionVersion: '1.0.0',
    });
    const outdated = await strict.request(`${origin}/api/v1/captures`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        origin: extension,
        'content-type': 'application/json',
        'x-extension-version': '0.9.0',
      },
      body: JSON.stringify({ capture: bundle([cookie()]) }),
    });
    expect(outdated.status).toBe(426);
    expect(outdated.headers.get('access-control-allow-origin')).toBe(extension);
  });

  it('refuse a token anywhere else, an invalid one even beside a session, and a token mutation from outside the extension', async () => {
    const a = await identity('a');
    const tokens = await connect(a);
    for (const [method, path] of [
      ['GET', '/computer'],
      ['GET', '/mcp/grants'],
      ['GET', '/browsers'],
      ['POST', '/sync/disconnect'],
      ['GET', '/setup'],
    ] as const)
      expect((await request(method, path, { token: tokens, cookie: a, from: origin })).status, path).toBe(401);
    expect((await request('GET', '/me', { token: 'x', cookie: a })).status).toBe(401);
    expect((await request('GET', '/me', { token: '', cookie: a })).status).toBe(401);
    const capture = { capture: bundle([cookie()]) };
    for (const from of [origin, unpinned, null])
      expect((await request('POST', '/captures', { token: tokens, from, body: capture })).status, String(from)).toBe(
        403,
      );
    expect(await db.select().from(schema.captures)).toEqual([]);
  });

  it('let only a sync token upload, delete, add sites, and adopt settings, and not our web app', async () => {
    const a = await identity('a');
    const tokens = await connect(a);
    for (const [method, path, body] of [
      ['POST', '/captures', { capture: bundle([cookie()]) }],
      ['DELETE', '/captures', undefined],
      ['POST', '/sync/adopt', { settings: local }],
    ] as const)
      expect(await json(await request(method, path, { cookie: a, from: origin, body })), path).toEqual({
        status: 403,
        body: { error: 'extension_only' },
      });
    expect(
      (await request('PATCH', '/sync', { cookie: a, from: origin, body: { addSites: ['notion.so'] } })).status,
    ).toBe(403);
    expect((await request('POST', '/sync/adopt', { token: tokens, body: { settings: local } })).status).toBe(200);
    expect((await request('PATCH', '/sync', { token: tokens, body: { addSites: ['notion.so'] } })).status).toBe(200);
  });

  it('tell builds before OAuth, which send the web session from the extension, to update', async () => {
    const a = await identity('a');
    const api = createApi({
      db,
      auth,
      origin,
      computers: fakeComputerProvider().provider,
      extensionVersion: '26.1022.0',
    });
    for (const [method, path] of [
      ['GET', '/me'],
      ['GET', '/sync'],
      ['PATCH', '/sync'],
      ['POST', '/sync/adopt'],
      ['POST', '/captures'],
      ['DELETE', '/captures'],
    ] as const) {
      const refused = await api.request(`${origin}/api/v1${path}`, {
        method,
        headers: {
          cookie: a,
          origin: extension,
          'content-type': 'application/json',
          'x-extension-version': '26.1021.1',
        },
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify({ capture: bundle([cookie()]) }) }),
      });
      expect(await json(refused), path).toEqual({
        status: 426,
        body: { error: 'extension_outdated', latestVersion: '26.1022.0' },
      });
      expect(refused.headers.get('access-control-allow-origin'), path).toBe(extension);
    }
    expect(await db.select().from(schema.captures)).toEqual([]);
  });

  it('disconnect the browser itself with DELETE /captures, leaving other browsers', async () => {
    const a = await identity('a');
    const one = await connect(a);
    const two = await connect(a, EDGE_ON_WINDOWS);
    expect((await request('POST', '/captures', { token: one, body: { capture: bundle([cookie()]) } })).status).toBe(
      200,
    );
    expect(await browsers(a)).toHaveLength(2);
    expect(await json(await request('DELETE', '/captures', { token: one }))).toEqual({
      status: 200,
      body: { deleted: true },
    });
    expect((await request('GET', '/me', { token: one })).status).toBe(401);
    expect((await request('GET', '/me', { token: two })).status).toBe(200);
    expect(await browsers(a)).toMatchObject([{ browser: 'edge' }]);
    expect(await db.select().from(schema.captures)).toEqual([]);
  });

  it('list and disconnect browsers from the account page only, per account', async () => {
    const a = await identity('a');
    const b = await identity('b');
    const one = await connect(a);
    const two = await connect(a);
    const theirs = await connect(b);
    for (const tokens of [one, two, theirs]) await request('GET', '/me', { token: tokens });
    await request('POST', '/captures', { token: two, body: { capture: bundle([cookie()]) } });
    const listed = await json(await request('GET', '/browsers', { cookie: a, from: origin }));
    expect(listed.status).toBe(200);
    expect(listed.body.browsers).toHaveLength(2);
    for (const browser of listed.body.browsers)
      expect(Object.keys(browser).sort()).toEqual(['browser', 'connectedAt', 'id', 'lastSyncedAt', 'platform']);
    const [first, second] = listed.body.browsers as { id: string; lastSyncedAt: string | null }[];
    expect(first!.lastSyncedAt).toBeNull();
    expect(second!.lastSyncedAt).toEqual(expect.any(String));
    const disconnect = (body: unknown, cookie = a, from: string = origin) =>
      request('POST', '/browsers/disconnect', { cookie, from, body });
    for (const body of [{}, { id: 'cmp_00000000000000000000000000' }, { id: first!.id, extra: 1 }, { id: 'brw_x' }])
      expect((await disconnect(body)).status, JSON.stringify(body)).toBe(400);
    expect((await disconnect({ id: 'brw_00000000000000000000000000' })).status).toBe(404);
    const [foreign] = (await (await request('GET', '/browsers', { cookie: b, from: origin })).json()).browsers;
    expect((await disconnect({ id: foreign.id })).status).toBe(404);
    expect((await disconnect({ id: first!.id }, a, extension)).status).toBe(403);
    // The first sent nothing, so the capture stays; the second sent it.
    expect(await json(await disconnect({ id: first!.id }))).toEqual({ status: 200, body: { disconnected: true } });
    expect((await disconnect({ id: first!.id })).status).toBe(404);
    expect(await db.select().from(schema.captures)).toHaveLength(1);
    expect((await request('GET', '/me', { token: one })).status).toBe(401);
    expect((await request('GET', '/me', { token: two })).status).toBe(200);
    expect((await disconnect({ id: second!.id })).status).toBe(200);
    expect(await db.select().from(schema.captures)).toEqual([]);
    expect(await browsers(a)).toEqual([]);
    expect(await browsers(b)).toHaveLength(1);
    expect((await request('GET', '/me', { token: theirs })).status).toBe(200);
  });

  it('disconnect every browser on Delete everything and Turn off sync, leaving agents connected', async () => {
    const a = await identity('a');
    await db.insert(schema.oauthClient).values({ id: 'agent', clientId: 'agent', redirectUris: [] });
    const now = new Date();
    await db.insert(schema.oauthConsent).values({
      id: randomUUID(),
      clientId: 'agent',
      userId: 'a',
      scopes: ['mcp:tools'],
      createdAt: now,
      updatedAt: now,
    });
    for (const [method, path] of [
      ['DELETE', '/computer'],
      ['POST', '/sync/disconnect'],
    ] as const) {
      const used = await connect(a);
      const tokens = [used, await connect(a)];
      await request('GET', '/me', { token: used });
      expect(await browsers(a)).toHaveLength(2);
      expect((await request(method, path, { cookie: a, from: origin })).status, path).toBe(200);
      for (const token of tokens) expect((await request('GET', '/me', { token })).status, path).toBe(401);
      expect(await browsers(a), path).toEqual([]);
      // A connected extension cannot lift Turn off sync with its old token.
      expect(
        (await request('POST', '/captures', { token: used, body: { capture: bundle([cookie()]), connect: true } }))
          .status,
      ).toBe(401);
    }
    expect(
      (await (await request('GET', '/mcp/grants', { cookie: a, from: origin })).json()).grants.map(
        (grant: { clientId: string }) => grant.clientId,
      ),
    ).toEqual(['agent']);
  });
});

describe("the extension's token client", () => {
  // The same functions the extension runs (packages/capture/src/oauth.ts), against real Better Auth. The controller
  // tests' fake token endpoint (apps/extension/src/controller.test.ts) assumes these outcomes.
  it('connects, rotates, replays within the reuse window, and is refused after it', async () => {
    const a = await identity('a');
    const redirectUri = `${extension}/connected.html`;
    const { verifier, challenge } = await pkce();
    const state = newState();
    const authorized = await auth.handler(
      new Request(authorizeUrl(origin, redirectUri, { state, challenge }), { headers: { cookie: a } }),
    );
    expect(authorized.status).toBe(302);
    const redirect = readRedirect(authorized.headers.get('location')!, redirectUri);
    expect(redirect).toEqual({ state, iss: issuerOf(origin), code: expect.any(String) });
    // From the extension's origin, without cookies.
    const fetcher = ((input: string, init: RequestInit) =>
      auth.handler(
        new Request(input, { ...init, headers: { ...(init.headers as object), origin: extension } }),
      )) as typeof fetch;
    const tokensOf = (result: TokenResult) => {
      if (typeof result !== 'object') throw new Error(`expected tokens, got ${result}`);
      return result.tokens;
    };
    const first = tokensOf(
      await requestTokens(fetcher, origin, { code: (redirect as { code: string }).code, verifier, redirectUri }),
    );
    expect(first.expiresAt - Date.now()).toBeGreaterThan(290_000);
    expect((await request('GET', '/me', { token: first.access })).status).toBe(200);
    const rotated = tokensOf(await requestTokens(fetcher, origin, { refreshToken: first.refresh }));
    expect(rotated.refresh).not.toBe(first.refresh);
    // A retry inside the reuse window gets the same answer.
    expect(tokensOf(await requestTokens(fetcher, origin, { refreshToken: first.refresh })).refresh).toBe(
      rotated.refresh,
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      expect(await requestTokens(fetcher, origin, { refreshToken: first.refresh })).toBe('invalid_grant');
      // That replay disconnected the browser, so its newer token is refused too.
      expect(await requestTokens(fetcher, origin, { refreshToken: rotated.refresh })).toBe('invalid_grant');
    } finally {
      vi.useRealTimers();
    }
    expect((await request('GET', '/me', { token: rotated.access })).status).toBe(401);
    // The code is single-use.
    expect(
      await requestTokens(fetcher, origin, { code: (redirect as { code: string }).code, verifier, redirectUri }),
    ).toBe('invalid_grant');
  });
});

describe('CORS outside the API', () => {
  it('adds CORS to a 503 on the extension routes only', () => {
    const at = (path: string, from: string) =>
      extensionCors(
        new Request(`${origin}${path}`, { headers: { origin: from } }),
        Response.json({ error: 'service_unavailable' }, { status: 503 }),
        extension,
      );
    for (const path of ['/api/v1/me', '/api/v1/sync', '/api/v1/sync/adopt', '/api/v1/captures']) {
      const answer = at(path, extension);
      expect(answer.status, path).toBe(503);
      expect(answer.headers.get('access-control-allow-origin'), path).toBe(extension);
      expect(answer.headers.get('access-control-allow-credentials'), path).toBeNull();
    }
    expect(at('/api/v1/computer', extension).headers.get('access-control-allow-origin')).toBeNull();
    expect(at('/api/v1/sync/disconnect', extension).headers.get('access-control-allow-origin')).toBeNull();
    expect(at('/api/v1/sync', unpinned).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers the pinned extension at the token endpoint without credentials, and refuses a cookie', async () => {
    const a = await identity('a');
    const tokens = await connect(a);
    const token = (from: string, extra: Record<string, string> = {}, refreshToken = tokens.refresh_token) => {
      const request = new Request(`${origin}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { origin: from, 'content-type': 'application/x-www-form-urlencoded', ...extra },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: 'agent-computers-extension',
          refresh_token: refreshToken,
        }).toString(),
      });
      return auth.handler(request.clone()).then(response => extensionCors(request, response));
    };
    const allowed = await token(extension);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(extension);
    expect(allowed.headers.get('access-control-allow-credentials')).toBeNull();
    const next = (await allowed.json()) as Tokens;
    const other = await token(unpinned, {}, next.refresh_token);
    expect(other.status).toBe(200);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const rotated = (await other.json()) as Tokens;
    expect((await token(extension, { cookie: a }, rotated.refresh_token)).status).toBe(403);
    const preflight = tokenPreflight(
      new Request(`${origin}/api/auth/oauth2/token`, { method: 'OPTIONS', headers: { origin: extension } }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(extension);
    const elsewhere = tokenPreflight(
      new Request(`${origin}/api/auth/sign-in/social`, { method: 'OPTIONS', headers: { origin: extension } }),
    );
    expect(elsewhere.status).toBe(405);
    expect(elsewhere.headers.get('access-control-allow-origin')).toBeNull();
  });
});
