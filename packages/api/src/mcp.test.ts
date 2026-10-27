import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { e2bComputerProvider } from '@agent-computers/e2b';
import { databaseSchema } from '@agent-computers/server/database-schema';
import { PGlite } from '@electric-sql/pglite';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createAuth } from '../../server/src/auth';
import { connectBrowser, EDGE_ON_WINDOWS, saveFromBrowser, syncingBrowser } from '../../server/src/browser-fixtures';
import { EXTENSION_CLIENT_ID, ensureExtensionClient, removeBrowser } from '../../server/src/browsers';
import { bundle, cookie } from '../../server/src/capture-fixtures';
import { deleteCaptures } from '../../server/src/captures';
import {
  COMPUTER_ID_PATTERN,
  deleteMainComputer,
  handBackComputer,
  liveViewStatus,
  openComputerSession,
  SESSION_ID_PATTERN,
  takeOverComputer,
} from '../../server/src/computers';
import type { ServerConfig } from '../../server/src/config';
import type { Database } from '../../server/src/database';
import { fakeComputerProvider } from '../../server/src/fake-computer-provider';
import { noMetering, noOperatorAdmin } from '../../server/src/hooks';
import {
  consentMembership,
  hasLiveGrant,
  liveMcpPrincipal,
  MCP_SCOPE,
  revokeMcpGrant,
  revokeMcpGrants,
} from '../../server/src/mcp';
import { inTheOrganization, switchTo } from '../../server/src/member-fixtures';
import { createOrganization, currentMember } from '../../server/src/organizations';
import * as schema from '../../server/src/schema';
import { createApi } from './index';
import { createMcpEndpoint } from './mcp';

const origin = 'http://localhost:3098';
const resource = `${origin}/api/mcp`;
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
let endpoint: ReturnType<typeof createMcpEndpoint>;
async function identity(id: string) {
  const person = { id, name: `Fixture ${id}`, email: `${id}@example.test` };
  await db.insert(schema.user).values({ ...person, emailVerified: true });
  // Into the deployment's organization, as sign-up does.
  await inTheOrganization(db, person);
  const token = randomBytes(32).toString('base64url');
  const sessionId = randomUUID();
  await db
    .insert(schema.session)
    .values({ id: sessionId, userId: id, token, expiresAt: new Date(Date.now() + 3600_000) });
  const signature = createHmac('sha256', config.BETTER_AUTH_SECRET).update(token).digest('base64');
  const context = await auth.$context;
  return {
    id,
    sessionId,
    cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`,
  };
}
function authRequest(
  path: string,
  {
    cookie,
    body,
    method = body ? 'POST' : 'GET',
  }: { cookie?: string; body?: Record<string, unknown>; method?: string } = {},
) {
  const form = path === '/oauth2/token';
  return auth.handler(
    new Request(`${origin}${path.startsWith('/.well-known') ? '' : '/api/auth'}${path}`, {
      method,
      headers: {
        origin,
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
      },
      ...(body
        ? { body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body) }
        : {}),
    }),
  );
}
// Agents identify with a client metadata document (CIMD); DCR is disabled.
const clientDocuments = new Map<string, Record<string, unknown>>();
const fetchClientMetadata = async (input: RequestInfo | URL) => {
  const document = clientDocuments.get(String(input instanceof Request ? input.url : input));
  return document
    ? Response.json(document, { headers: { 'cache-control': 'max-age=60' } })
    : new Response(null, { status: 404 });
};
async function register(clientId = `https://client.example.test/clients/${randomUUID()}.json`) {
  clientDocuments.set(clientId, {
    client_id: clientId,
    client_name: 'Fixture agent',
    redirect_uris: ['https://client.example.test/callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
  return clientId;
}
async function authorize(cookie: string, client: string, scope = 'openid offline_access mcp:tools', accept = true) {
  const verifier = randomBytes(48).toString('base64url');
  const query = new URLSearchParams({
    client_id: client,
    redirect_uri: 'https://client.example.test/callback',
    response_type: 'code',
    scope,
    resource,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: randomUUID(),
    prompt: 'consent',
  });
  const response = await authRequest(`/oauth2/authorize?${query}`, { cookie });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!, origin);
  expect(location.pathname).toBe('/consent');
  const consent = await authRequest('/oauth2/consent', {
    cookie,
    body: { accept, oauth_query: location.search.slice(1) },
  });
  expect(consent.status).toBe(200);
  const redirect = new URL((await consent.json()).url);
  if (!accept) {
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    return null;
  }
  expect(redirect.origin).toBe('https://client.example.test');
  const code = redirect.searchParams.get('code');
  expect(!!code).toBe(true);
  const tokenResponse = await authRequest('/oauth2/token', {
    body: {
      grant_type: 'authorization_code',
      client_id: client,
      code: code!,
      code_verifier: verifier,
      redirect_uri: 'https://client.example.test/callback',
      resource,
    },
  });
  expect(tokenResponse.status).toBe(200);
  return (await tokenResponse.json()) as { access_token: string; refresh_token: string };
}
async function call(
  token?: string,
  method = 'tools/call',
  params: Record<string, unknown> = { name: 'account_identity', arguments: {} },
  version = '2025-11-25',
) {
  if (version === '2026-07-28')
    params = {
      ...params,
      _meta: {
        ...((params._meta as Record<string, unknown>) ?? {}),
        'io.modelcontextprotocol/protocolVersion': version,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    };
  return endpoint(
    new Request(resource, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': version,
        ...(version === '2026-07-28'
          ? { 'mcp-method': method, ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}) }
          : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
}
async function rpc(response: Response) {
  const text = await response.text();
  // Slow tool calls stream SSE keepalive comments before the data line.
  const data = text.split('\n').find(line => line.startsWith('data: '));
  return JSON.parse(data ? data.slice(6) : text);
}
// Migrate once per file and give each test a clone, which is much faster than a new database.
// The member a person acts as, which the routes resolve from the session.
const member = async (userId: string) => (await currentMember(db, userId))!;
// The reference a consent for the person's current membership carries, as the consent page writes it.
const membershipOf = async (userId: string) => (await consentMembership(db, userId))!;
let template: PGlite;
beforeAll(async () => {
  template = new PGlite();
  const templateDb = drizzle(template, { schema: databaseSchema });
  await migrate(templateDb, {
    migrationsFolder: fileURLToPath(new URL('../../server/migrations', import.meta.url)),
  });
  // One signing key for every clone, as in production: Better Auth caches the JWKS per URL across
  // auth instances and refetches for an unknown key at most every 30 seconds.
  const templateAuth = createAuth(templateDb as unknown as Database, config, { fetchClientMetadata });
  await templateAuth.handler(new Request(`${origin}/api/auth/jwks`));
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  const embedded = drizzle(pg, { schema: databaseSchema });
  db = embedded as unknown as Database;
  auth = createAuth(db, config, { fetchClientMetadata });
  await auth.$context;
  endpoint = createMcpEndpoint({ db, auth, origin, computers: fakeComputerProvider().provider });
  // Exercise the real provider's JWKS and real signatures without a network listener.
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const req = input instanceof Request ? input : new Request(String(input));
    if (req.url === `${origin}/api/auth/jwks`) return auth.handler(req);
    throw new Error('Unexpected external request in synthetic OAuth test');
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await pg.close();
});

describe('remote MCP OAuth boundary', () => {
  it('keeps browser consent on the canonical origin after a hostname migration', async () => {
    const legacy = 'https://legacy.example.test';
    const client = await register();
    const query = new URLSearchParams({
      client_id: client,
      redirect_uri: 'https://client.example.test/callback',
      response_type: 'code',
      scope: 'openid mcp:tools',
      resource,
      code_challenge: createHash('sha256').update(randomBytes(48)).digest('base64url'),
      code_challenge_method: 'S256',
    });
    const response = await auth.handler(new Request(`http://legacy.example.test/api/auth/oauth2/authorize?${query}`));
    expect(response.status).toBe(302);
    const destination = new URL(response.headers.get('location')!);
    expect(destination.origin).toBe(origin);
    expect(destination.pathname).toBe('/sign-in');
    const a = await identity('a');
    const rejected = await auth.handler(
      new Request(`${origin}/api/auth/oauth2/consent`, {
        method: 'POST',
        headers: { origin: legacy, cookie: a.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ accept: true, oauth_query: destination.search.slice(1) }),
      }),
    );
    expect(rejected.status).toBe(403);
  });
  it('publishes OAuth metadata but requires sign-in from the first MCP request', async () => {
    const metadata = await authRequest('/.well-known/oauth-protected-resource/api/mcp');
    expect(metadata.status).toBe(200);
    expect((await metadata.json()).resource).toBe(resource);
    const discovery = await authRequest('/.well-known/oauth-authorization-server/api/auth');
    expect(discovery.status).toBe(200);
    const value = await discovery.json();
    expect(value.code_challenge_methods_supported).toContain('S256');
    expect(value.client_id_metadata_document_supported).toBe(true);
    expect(value.registration_endpoint).toBeUndefined();
    const registration = await authRequest('/oauth2/register', {
      body: {
        client_name: 'Unregistered',
        redirect_uris: ['https://client.example.test/callback'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(registration.status).toBeGreaterThanOrEqual(400);
    expect(await db.select().from(schema.oauthClient)).toHaveLength(0);
    for (const method of ['initialize', 'notifications/initialized', 'tools/list', 'server/discover', 'tools/call']) {
      const missing = await call(undefined, method, {});
      expect(missing.status, method).toBe(401);
      expect(missing.headers.get('www-authenticate')).toContain(
        `resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`,
      );
      expect(missing.headers.get('www-authenticate')).toContain('mcp:tools');
      expect(missing.headers.get('cache-control')).toBe('no-store');
    }
    const a = await identity('a');
    const token = (await authorize(a.cookie, await register()))!;
    const initialized = await rpc(
      await call(token.access_token, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'fixture-agent', version: '1.0.0' },
      }),
    );
    expect(initialized.result.capabilities.tools).toBeDefined();
    const listed = await rpc(await call(token.access_token, 'tools/list', {}));
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'account_identity',
      'computer_open',
      'computer_close',
      'computer_list',
      'computer_delete',
      'computer_screenshot',
      'computer_act',
      'browser_cdp',
      'computer_exec',
    ]);
    const discovered = await rpc(await call(token.access_token, 'server/discover', {}, '2026-07-28'));
    expect(discovered.error).toBeUndefined();
    expect(discovered.result).toBeDefined();
    await revokeMcpGrants(db, await member(a.id));
    for (const method of ['initialize', 'tools/list', 'server/discover']) {
      expect((await call(token.access_token, method, {})).status, method).toBe(401);
      expect((await call('forged', method, {})).status, method).toBe(401);
    }
  });
  it('completes real PKCE and consent; isolates concurrent callers and rejects missing scope', async () => {
    const a = await identity('a');
    const b = await identity('b');
    const client = await register();
    const first = (await authorize(a.cookie, client))!;
    const second = (await authorize(b.cookie, client))!;
    const results = await Promise.all(
      [first, second, first, second].map(async token => rpc(await call(token.access_token))),
    );
    expect(results.map(value => value.result.structuredContent.user_id)).toEqual(['a', 'b', 'a', 'b']);
    expect(results[0].result.structuredContent.protocol_version).toBe('2025-11-25');
    const limited = (await authorize(a.cookie, client, 'openid offline_access'))!;
    expect((await call(limited.access_token)).status).toBe(403);
    expect((await call(first.access_token)).status).toBe(401);
  });
  it('cuts off a banned user immediately and restores access when the ban lifts, recording activity', async () => {
    const active: string[] = [];
    const operatorAdmin = {
      ...noOperatorAdmin,
      recordActivity: async (_db: unknown, userId: string) => {
        active.push(userId);
      },
    };
    endpoint = createMcpEndpoint({
      db,
      auth,
      origin,
      computers: fakeComputerProvider().provider,
      hooks: { metering: noMetering, operatorAdmin },
    });
    const a = await identity('a');
    const client = await register();
    const token = (await authorize(a.cookie, client))!;
    expect((await call(token.access_token)).status).toBe(200);
    await db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, a.id));
    expect((await call(token.access_token)).status).toBe(401);
    await db.update(schema.user).set({ banned: false }).where(eq(schema.user.id, a.id));
    expect((await call(token.access_token)).status).toBe(200);
    // The operator admin hook hears of each call that got through.
    expect(active).toEqual([a.id, a.id]);
  });
  it('denies consent without issuing a grant', async () => {
    const a = await identity('a');
    const client = await register();
    await authorize(a.cookie, client, undefined, false);
    expect((await db.select().from(schema.oauthConsent)).length).toBe(0);
  });
  it('rejects expiry, refreshes, revokes immediately, and never revives old tokens after reconnect', async () => {
    const a = await identity('a');
    const client = await register();
    const initial = (await authorize(a.cookie, client))!;
    expect((await authRequest('/oauth2/delete-consent', { cookie: a.cookie, body: { id: 'unused' } })).status).toBe(
      404,
    );
    expect((await authRequest('/oauth2/update-consent', { cookie: a.cookie, body: { id: 'unused' } })).status).toBe(
      404,
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 301_000);
    expect((await call(initial.access_token)).status).toBe(401);
    const refresh = await authRequest('/oauth2/token', {
      body: { grant_type: 'refresh_token', client_id: client, refresh_token: initial.refresh_token, resource },
    });
    expect(refresh.status).toBe(200);
    const rotated = await refresh.json();
    expect((await call(rotated.access_token)).status).toBe(200);
    await revokeMcpGrants(db, await member(a.id));
    expect((await call(rotated.access_token)).status).toBe(401);
    const denied = await authRequest('/oauth2/token', {
      body: { grant_type: 'refresh_token', client_id: client, refresh_token: rotated.refresh_token, resource },
    });
    expect(denied.status).toBe(400);
    // Tokens carry whole-second issue times; reconnecting happens at least a second later.
    vi.setSystemTime(Date.now() + 1000);
    const reconnected = (await authorize(a.cookie, client))!;
    expect((await call(reconnected.access_token)).status).toBe(200);
    expect((await call(rotated.access_token)).status).toBe(401);
  });
  it('rejects forged tokens and wrong resource, but outlives the web login session', async () => {
    const a = await identity('a');
    const client = await register();
    const token = (await authorize(a.cookie, client))!;
    const other = createMcpEndpoint({
      db,
      auth,
      origin: `${origin}/wrong`,
      computers: fakeComputerProvider().provider,
    });
    expect(
      (
        await other(
          new Request(resource, {
            method: 'POST',
            headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'account_identity', arguments: {} },
            }),
          }),
        )
      ).status,
    ).toBe(401);
    expect((await call('forged')).status).toBe(401);
    await db.delete(schema.session).where(eq(schema.session.id, a.sessionId));
    expect((await call(token.access_token)).status).toBe(200);
    const refreshed = await authRequest('/oauth2/token', {
      body: { grant_type: 'refresh_token', client_id: client, refresh_token: token.refresh_token, resource },
    });
    expect(refreshed.status).toBe(200);
    expect((await call((await refreshed.json()).access_token)).status).toBe(200);
  });
  it('scopes grant listing and revocation to the signed-in account and checks mutation origins', async () => {
    const a = await identity('a');
    const b = await identity('b');
    const client = await register();
    const first = (await authorize(a.cookie, client))!;
    const second = (await authorize(b.cookie, client))!;
    const api = createApi({ db, auth, origin, computers: fakeComputerProvider().provider });
    const request = (path: string, cookie: string, method = 'GET', requestOrigin = origin) =>
      api.request(`${origin}/api/v1/mcp/${path}`, { method, headers: { cookie, origin: requestOrigin } });
    const listed = await (await request('grants', a.cookie)).json();
    expect(listed.grants.length).toBe(1);
    expect((await request('revoke', a.cookie, 'POST', 'https://evil.test')).status).toBe(403);
    expect((await request('revoke', a.cookie, 'POST')).status).toBe(200);
    expect((await call(first.access_token)).status).toBe(401);
    expect((await call(second.access_token)).status).toBe(200);
  });
  it('keeps sync and MCP tokens apart, and never treats the extension as an agent', async () => {
    const extension = `chrome-extension://${'a'.repeat(32)}`;
    vi.stubEnv('EXTENSION_ORIGINS', extension);
    await ensureExtensionClient(db, extension);
    for (const path of [
      '/.well-known/oauth-protected-resource/api/mcp',
      '/.well-known/oauth-authorization-server/api/auth',
    ])
      expect((await (await authRequest(path)).json()).scopes_supported, path).not.toContain('sync');
    const a = await identity('a');
    // An agent cannot ask for the extension's scope.
    const client = await register();
    const refused = await authRequest(
      `/oauth2/authorize?${new URLSearchParams({
        client_id: client,
        redirect_uri: 'https://client.example.test/callback',
        response_type: 'code',
        scope: 'offline_access mcp:tools sync',
        resource,
        code_challenge: createHash('sha256').update(randomBytes(48)).digest('base64url'),
        code_challenge_method: 'S256',
      })}`,
      { cookie: a.cookie },
    );
    expect(new URL(refused.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope');
    const agent = (await authorize(a.cookie, client))!;
    const browser = await connectBrowser(auth, a.cookie, { extensionOrigin: extension });
    // Neither token works where the other belongs.
    expect((await call(browser.access_token)).status).toBe(401);
    const api = createApi({ db, auth, origin, computers: fakeComputerProvider().provider });
    const v1 = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
      api.request(`${origin}/api/v1${path}`, {
        method,
        headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const as = (token: string) => ({ authorization: `Bearer ${token}`, origin: extension });
    expect((await v1('GET', '/me', as(agent.access_token))).status).toBe(401);
    expect((await v1('POST', '/captures', as(agent.access_token), { capture: bundle([cookie()]) })).status).toBe(401);
    expect((await v1('GET', '/me', as(browser.access_token))).status).toBe(200);
    // Agents' disconnects leave the browser connected, and the extension is not an agent.
    const page = { cookie: a.cookie, origin };
    expect((await v1('POST', '/mcp/grants/revoke', page, { clientId: EXTENSION_CLIENT_ID })).status).toBe(404);
    expect((await (await v1('GET', '/mcp/grants', page)).json()).grants).toHaveLength(1);
    expect((await v1('POST', '/mcp/revoke', page)).status).toBe(200);
    expect((await call(agent.access_token)).status).toBe(401);
    expect((await (await v1('GET', '/mcp/grants', page)).json()).grants).toEqual([]);
    expect((await v1('GET', '/me', as(browser.access_token))).status).toBe(200);
    expect((await v1('GET', '/sync', as(browser.access_token))).status).toBe(200);
    // Even with a consent row, which it never writes, the extension is no agent.
    const now = new Date();
    await db.insert(schema.oauthConsent).values({
      id: randomUUID(),
      clientId: EXTENSION_CLIENT_ID,
      userId: 'a',
      scopes: [MCP_SCOPE],
      createdAt: now,
      updatedAt: now,
    });
    const claims = { sub: 'a', client_id: EXTENSION_CLIENT_ID, iat: Math.floor(Date.now() / 1000) + 1 };
    expect(await liveMcpPrincipal(db, claims)).toBeNull();
    expect(await hasLiveGrant(db, 'a')).toBe(false);
    expect((await (await v1('GET', '/mcp/grants', page)).json()).grants).toEqual([]);
  });
});

describe('main computer tools', () => {
  const tool = (token: string, name: string, args: Record<string, unknown>, target = endpoint) =>
    target(
      new Request(resource, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
    ).then(rpc);
  it('opens a computer per agent, runs every tool in its session, and reopens, lists, and deletes computers', async () => {
    const fake = fakeComputerProvider();
    vi.stubEnv('CAPTURE_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    endpoint = createMcpEndpoint({ db, auth, origin, computers: fake.provider });
    const a = await identity('a');
    const claude = (await authorize(a.cookie, await register()))!;
    const initialized = await rpc(
      await call(claude.access_token, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'fixture-agent', version: '1.0.0' },
      }),
    );
    expect(initialized.result.instructions).toContain('computer_close');
    expect(initialized.result.instructions).toContain('computer_id');
    expect(initialized.result.instructions).not.toContain('pending_sync');
    // The agent can name the account it is connected as, so a user can spot the wrong one of their accounts.
    expect(initialized.result.instructions).toContain('a@example.test');
    expect((await rpc(await call(claude.access_token))).result.structuredContent).toMatchObject({
      access_model: 'computer_session',
      account_email: 'a@example.test',
    });
    const chatgpt = (await authorize(a.cookie, await register()))!;
    const opened = await tool(claude.access_token, 'computer_open', { label: '  Invoices  ' });
    expect(opened.result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const id = opened.result.structuredContent.session_id;
    const computerId = opened.result.structuredContent.computer_id;
    expect(id).toMatch(SESSION_ID_PATTERN);
    expect(computerId).toMatch(COMPUTER_ID_PATTERN);
    expect(opened.result.structuredContent).toMatchObject({
      idle_pause_seconds: 60,
      label: 'Invoices',
      new_computer: true,
    });
    expect(opened.result.structuredContent.sign_in_help).toContain(`${origin}/app`);
    expect(opened.result.structuredContent.sign_in_help).not.toContain('pending_sync');
    expect(opened.result.structuredContent.account_email).toBe('a@example.test');
    expect(opened.result.structuredContent.browser_sync).toContain(
      'No browser has synced to the Clutchbox account a@example.test',
    );
    // The default hooks have no allowance.
    expect(opened.result.structuredContent).not.toHaveProperty('allowance');
    const acted = await tool(claude.access_token, 'computer_act', {
      session_id: id,
      actions: [
        { type: 'click', x: 10, y: 20 },
        { type: 'type', text: 'hello' },
        { type: 'key', keys: ['ctrl', 'l'] },
      ],
    });
    expect(acted.result.structuredContent).toMatchObject({ session_id: id, completed: 3, unexecuted: 0 });
    expect(
      (await tool(claude.access_token, 'computer_exec', { session_id: id, command: 'ls' })).result.structuredContent,
    ).toMatchObject({ session_id: id, exit_code: 0, stdout: 'ran: ls' });
    expect(
      (await tool(claude.access_token, 'browser_cdp', { session_id: id, method: 'Target.getTargets' })).result
        .structuredContent.result,
    ).toEqual({ targetInfos: [] });
    // Every call ends by letting the computer pause after the idle minute.
    expect(fake.calls.setTimeouts.every(ms => ms === 60_000)).toBe(true);
    // A sign-in on the host never reaches a computer session; the agent reopens with its session to apply it.
    await saveFromBrowser(db, await member(a.id), bundle([cookie()]));
    const shot = (await tool(claude.access_token, 'computer_screenshot', { session_id: id })).result.structuredContent;
    expect(shot).toEqual({ session_id: id, display: { width: 1280, height: 800 } });
    expect(fake.calls.sync).toBe(0);
    // Another agent, or the same one without its session_id, finds this computer busy; others' IDs are not theirs.
    for (const token of [chatgpt.access_token, claude.access_token]) {
      const busy = await tool(token, 'computer_open', { computer_id: computerId });
      expect(busy.result).toMatchObject({ isError: true, structuredContent: { error: 'busy' } });
      expect(new Date(busy.result.structuredContent.busy_until).getTime()).toBeGreaterThan(Date.now());
    }
    expect(
      (await tool(chatgpt.access_token, 'computer_screenshot', { session_id: id })).result.structuredContent.error,
    ).toBe('session_not_found');
    const reopened = await tool(claude.access_token, 'computer_open', { session_id: id });
    expect(reopened.result.structuredContent).toMatchObject({ computer_id: computerId, new_computer: false });
    expect(reopened.result.structuredContent.browser_sync).toContain('1 site updated');
    const next = reopened.result.structuredContent.session_id;
    expect(next).not.toBe(id);
    expect(
      (await tool(claude.access_token, 'computer_screenshot', { session_id: id })).result.structuredContent,
    ).toMatchObject({ error: 'session_ended', message: expect.stringContaining('computer_open') });
    // Another agent gets a computer of its own meanwhile.
    const own = (await tool(chatgpt.access_token, 'computer_open', {})).result.structuredContent;
    expect(own).toMatchObject({ new_computer: true });
    expect(own.computer_id).not.toBe(computerId);
    // Closing pauses the computer and frees it for other agents, which reopen it by its ID.
    const closed = await tool(claude.access_token, 'computer_close', { session_id: next });
    expect(closed.result.structuredContent).toEqual({ closed: true });
    expect(
      (await tool(claude.access_token, 'computer_close', { session_id: next })).result.structuredContent.error,
    ).toBe('session_ended');
    const list = (await tool(chatgpt.access_token, 'computer_list', {})).result.structuredContent;
    expect(list.computers).toEqual([
      {
        computer_id: own.computer_id,
        label: null,
        created_at: expect.any(String),
        last_used_at: expect.any(String),
        status: 'in_use',
      },
      expect.objectContaining({ computer_id: computerId, label: 'Invoices', status: 'paused' }),
    ]);
    const taken = (await tool(chatgpt.access_token, 'computer_open', { computer_id: computerId })).result;
    expect(taken.structuredContent).toMatchObject({ computer_id: computerId, new_computer: false });
    // Once the user stops syncing, the next open signs the computer out of the sites it had synced, naming them.
    await deleteCaptures(db, await member(a.id));
    const signedOut = (
      await tool(chatgpt.access_token, 'computer_open', { session_id: taken.structuredContent.session_id })
    ).result;
    expect(signedOut.structuredContent.browser_sync).toContain('signed out of the sites it had synced: example.com.');
    // Deleting: another agent's active session means busy; then it is gone.
    expect(
      (await tool(claude.access_token, 'computer_delete', { computer_id: computerId })).result.structuredContent,
    ).toMatchObject({ error: 'busy' });
    expect(
      (await tool(chatgpt.access_token, 'computer_delete', { computer_id: computerId })).result.structuredContent,
    ).toEqual({ deleted: true });
    for (const name of ['computer_delete', 'computer_open'])
      expect(
        (await tool(chatgpt.access_token, name, { computer_id: computerId })).result.structuredContent.error,
        name,
      ).toBe('computer_not_found');
    expect(
      (await tool(chatgpt.access_token, 'computer_screenshot', { session_id: taken.structuredContent.session_id }))
        .result.structuredContent.error,
    ).toBe('session_not_found');
    // Revoking agents ends their sessions; reconnecting reaches the same main computer.
    await revokeMcpGrants(db, await member(a.id));
    expect(
      (await call(claude.access_token, 'tools/call', { name: 'computer_screenshot', arguments: { session_id: next } }))
        .status,
    ).toBe(401);
    expect(await db.select().from(schema.computerSessions).where(isNull(schema.computerSessions.endedAt))).toEqual([]);
    const renewed = (await authorize(a.cookie, await register()))!;
    expect((await tool(renewed.access_token, 'computer_open', {})).result.isError).toBe(false);
    expect(fake.calls.create).toBe(1);
  });
  it("reports the metering hook's allowance, in its words, on open and close", async () => {
    const usage = {
      usedSeconds: 90,
      allowanceSeconds: 36_000,
      remainingSeconds: 35_910,
      resetsAt: new Date('2026-11-01T00:00:00Z'),
      name: 'free minutes',
      hardStop: true,
    };
    const metering = { ...noMetering, usage: async () => usage };
    endpoint = createMcpEndpoint({
      db,
      auth,
      origin,
      computers: fakeComputerProvider().provider,
      hooks: { metering, operatorAdmin: noOperatorAdmin },
    });
    const token = (await authorize((await identity('a')).cookie, await register()))!.access_token;
    const minutes = {
      allowance: {
        name: 'free minutes',
        minutes_remaining: 598,
        resets_at: '2026-11-01T00:00:00.000Z',
        when_used_up: 'refused',
      },
    };
    const opened = (await tool(token, 'computer_open', {})).result.structuredContent;
    expect(opened).toMatchObject(minutes);
    expect(
      (await tool(token, 'computer_close', { session_id: opened.session_id })).result.structuredContent,
    ).toMatchObject(minutes);
  });
  it('gives every account its own computer and keeps other users off it', async () => {
    const fake = fakeComputerProvider();
    endpoint = createMcpEndpoint({ db, auth, origin, computers: fake.provider });
    const a = await identity('a');
    const b = await identity('b');
    const client = await register();
    const id = (await tool((await authorize(a.cookie, client))!.access_token, 'computer_open', {})).result
      .structuredContent.session_id;
    const outsider = (await authorize(b.cookie, client))!;
    for (const name of ['computer_screenshot', 'computer_close'])
      expect((await tool(outsider.access_token, name, { session_id: id })).result.structuredContent.error, name).toBe(
        'session_not_found',
      );
    // Passing another user's session_id to computer_open never takes over their session.
    const own = await tool(outsider.access_token, 'computer_open', { session_id: id });
    expect(own.result.structuredContent.session_id).toMatch(SESSION_ID_PATTERN);
    expect(own.result.structuredContent.session_id).not.toBe(id);
    expect(fake.calls.create).toBe(2);
    expect(
      (await db.select().from(schema.computerSessions).where(eq(schema.computerSessions.publicId, id)))[0]!.endedAt,
    ).toBeNull();
    // A malformed ID fails validation before reaching the computer.
    const malformed = await tool(outsider.access_token, 'computer_screenshot', { session_id: 'cs_short' });
    expect(malformed.error ?? malformed.result.isError).toBeTruthy();
  });
  it("opens on the browser profile it names, lists the user's profiles, and says when one stops syncing", async () => {
    const fake = fakeComputerProvider();
    vi.stubEnv('CAPTURE_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    endpoint = createMcpEndpoint({ db, auth, origin, computers: fake.provider });
    const a = await identity('a');
    const token = (await authorize(a.cookie, await register()))!.access_token;
    const mine = await member(a.id);
    const work = await syncingBrowser(db, mine, { name: 'work' });
    const personal = await syncingBrowser(db, mine, { name: 'personal', userAgent: EDGE_ON_WINDOWS });
    for (const browser of [work, personal])
      await saveFromBrowser(db, mine, bundle([cookie()]), { browser: browser.id });
    const profiles = [
      { profile_id: personal.publicId, browser: 'edge', platform: 'windows', default: true },
      { profile_id: work.publicId, browser: 'chrome', platform: 'macos', default: false },
    ].map(profile => ({ ...profile, last_synced_at: expect.any(String) }));
    // Without one, the browser synced last.
    const opened = (await tool(token, 'computer_open', {})).result.structuredContent;
    expect(opened).toMatchObject({ profile: profiles[0], profiles });
    expect((await tool(token, 'computer_list', {})).result.structuredContent.profiles).toEqual(profiles);
    const named = (await tool(token, 'computer_open', { session_id: opened.session_id, profile: work.publicId })).result
      .structuredContent;
    expect(named).toMatchObject({ computer_id: opened.computer_id, profile: profiles[1] });
    expect(fake.calls.profiles.map(call => call.profile)).toEqual(['default', work.publicId]);
    // Once that browser no longer syncs here, naming it is an error the agent can act on, and the session goes on.
    expect(await removeBrowser(db, mine, work.publicId)).toBe(true);
    const gone = (await tool(token, 'computer_open', { session_id: named.session_id, profile: work.publicId })).result;
    expect(gone).toMatchObject({ isError: true, structuredContent: { error: 'profile_not_found' } });
    expect(gone.structuredContent.message).toContain('Omit profile');
    expect(
      (await tool(token, 'computer_screenshot', { session_id: named.session_id })).result.structuredContent,
    ).toMatchObject({ session_id: named.session_id });
  });
  it('tells an agent the user took control, shows it waiting, and says so once after the hand-back', async () => {
    const fake = fakeComputerProvider();
    endpoint = createMcpEndpoint({ db, auth, origin, computers: fake.provider });
    const a = await identity('a');
    const claude = (await authorize(a.cookie, await register()))!;
    const chatgpt = (await authorize(a.cookie, await register()))!;
    const initialized = await rpc(
      await call(claude.access_token, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'fixture-agent', version: '1.0.0' },
      }),
    );
    expect(initialized.result.instructions).toContain('user_in_control');
    expect(initialized.result.instructions).not.toContain('took over');
    const opened = (await tool(claude.access_token, 'computer_open', {})).result.structuredContent;
    const id = opened.session_id;
    // The user takes over the agent's computer, say to pass a bot check for it.
    const fork = { computerId: opened.computer_id };
    const page = randomUUID();
    expect(
      await takeOverComputer(db, { provider: fake.provider, metering: noMetering }, await member(a.id), page, fork),
    ).toMatchObject({
      takeover: { mine: true },
    });
    const waiting = (await tool(claude.access_token, 'computer_screenshot', { session_id: id })).result;
    expect(waiting).toMatchObject({ isError: true, structuredContent: { error: 'user_in_control' } });
    expect(waiting.structuredContent.message).toContain('session_id');
    expect(waiting.structuredContent.busy_until).toBeUndefined();
    const busy = (await tool(chatgpt.access_token, 'computer_open', { computer_id: fork.computerId })).result;
    expect(busy).toMatchObject({ isError: true, structuredContent: { error: 'busy' } });
    expect(busy.structuredContent.busy_until).toBeUndefined();
    // The recorded user_in_control call is what the live view shows as a waiting agent.
    expect(
      (await liveViewStatus(db, noMetering, await member(a.id), page, undefined, fork)).agentWaiting,
    ).toMatchObject({
      since: expect.any(String),
    });
    await handBackComputer(db, { provider: fake.provider, metering: noMetering }, await member(a.id), page, fork);
    const back = (await tool(claude.access_token, 'computer_screenshot', { session_id: id })).result;
    expect(back.isError).toBe(false);
    expect(back.structuredContent).toMatchObject({
      session_id: id,
      user_had_control: { message: expect.stringContaining('screenshot') },
    });
    const after = (await tool(claude.access_token, 'computer_screenshot', { session_id: id })).result;
    expect(after.structuredContent.user_had_control).toBeUndefined();
    // A reopen with the session_id right after a hand-back says so too.
    await takeOverComputer(db, { provider: fake.provider, metering: noMetering }, await member(a.id), page, fork);
    await handBackComputer(db, { provider: fake.provider, metering: noMetering }, await member(a.id), page, fork);
    const reopened = (await tool(claude.access_token, 'computer_open', { session_id: id })).result;
    expect(reopened.structuredContent).toMatchObject({
      user_had_control: { message: expect.stringContaining('screenshot') },
    });
  });
  // route.ts allows 120s; exec, act, and their final screenshot must finish inside it.
  it('keeps exec and act inside the request time budget', async () => {
    const fake = fakeComputerProvider();
    const timeouts: number[] = [];
    let actMs = 0;
    const provider = {
      ...fake.provider,
      async connect(sandboxId: string, timeoutMs: number) {
        const session = await fake.provider.connect(sandboxId, timeoutMs);
        return {
          ...session,
          act: async (action: Parameters<typeof session.act>[0]) => {
            vi.setSystemTime(Date.now() + actMs);
            await session.act(action);
          },
          exec: async (input: Parameters<typeof session.exec>[0]) => {
            timeouts.push(input.timeoutSeconds);
            return session.exec(input);
          },
        };
      },
    };
    endpoint = createMcpEndpoint({ db, auth, origin, computers: provider });
    const a = await identity('a');
    const token = (await authorize(a.cookie, await register()))!.access_token;
    const id = (await tool(token, 'computer_open', {})).result.structuredContent.session_id;
    const invalid = (response: { result?: { isError?: boolean; content: { text: string }[] }; error?: unknown }) =>
      response.error ?? (response.result?.isError && response.result.content[0]!.text);
    expect(
      invalid(await tool(token, 'computer_exec', { session_id: id, command: 'sleep 200', timeout_seconds: 91 })),
    ).toBeTruthy();
    expect(
      (await tool(token, 'computer_exec', { session_id: id, command: 'ls', timeout_seconds: 90 })).result
        .structuredContent,
    ).toMatchObject({ exit_code: 0 });
    expect(timeouts).toEqual([90]);
    expect(
      invalid(
        await tool(token, 'computer_act', {
          session_id: id,
          actions: Array.from({ length: 20 }, () => ({ type: 'wait', ms: 5000 })),
        }),
      ),
    ).toBeTruthy();
    expect(
      invalid(
        await tool(token, 'computer_act', {
          session_id: id,
          actions: [
            { type: 'type', text: 'x'.repeat(2000) },
            { type: 'type', text: 'y' },
          ],
        }),
      ),
    ).toBeTruthy();
    // Slow actions: the loop stops at the deadline and still reports counts with a screenshot.
    actMs = 30_000;
    const acted = await tool(token, 'computer_act', {
      session_id: id,
      actions: Array.from({ length: 6 }, () => ({ type: 'click', x: 1, y: 1 })),
    });
    expect(acted.result.content[0]).toMatchObject({ type: 'image' });
    expect(acted.result.structuredContent).toMatchObject({ completed: 4, unexecuted: 2, stopped: expect.any(String) });
    expect(acted.result.structuredContent.failed).toBeUndefined();
  });
  it('reports unreadable CDP replies as CDP errors, not an unresponsive computer', async () => {
    const fake = fakeComputerProvider();
    const replies = ['not json', '"text"'];
    const provider = {
      ...fake.provider,
      async connect(sandboxId: string, timeoutMs: number) {
        return { ...(await fake.provider.connect(sandboxId, timeoutMs)), cdp: async () => replies.shift()! };
      },
    };
    endpoint = createMcpEndpoint({ db, auth, origin, computers: provider });
    const a = await identity('a');
    const token = (await authorize(a.cookie, await register()))!.access_token;
    const id = (await tool(token, 'computer_open', {})).result.structuredContent.session_id;
    for (const _ of [1, 2])
      expect((await tool(token, 'browser_cdp', { session_id: id, method: 'Target.getTargets' })).result).toMatchObject({
        isError: true,
        structuredContent: { error: 'cdp_invalid_response' },
      });
  });
  it('records every call with its outcome and failing step, never its arguments or results', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = fakeComputerProvider();
    const fails = { connect: false, screenshot: false };
    const provider = {
      ...fake.provider,
      async connect(sandboxId: string, timeoutMs: number) {
        if (fails.connect) throw new Error('connect failed in fake');
        const session = await fake.provider.connect(sandboxId, timeoutMs);
        return {
          ...session,
          screenshot: async () => {
            if (fails.screenshot) throw Object.assign(new Error('hunter2 in a message'), { name: 'TimeoutError' });
            return session.screenshot();
          },
        };
      },
    };
    endpoint = createMcpEndpoint({ db, auth, origin, computers: provider });
    const a = await identity('a');
    const token = (await authorize(a.cookie, await register()))!.access_token;
    const other = (await authorize(a.cookie, await register()))!.access_token;
    expect((await rpc(await call(token))).result.isError).toBe(false);
    const opened = (await tool(token, 'computer_open', {})).result.structuredContent;
    const id = opened.session_id;
    await tool(token, 'computer_act', { session_id: id, actions: [{ type: 'type', text: 'hunter2' }] });
    expect((await tool(token, 'computer_exec', { session_id: id, command: 'echo hunter2' })).result.isError).toBe(
      false,
    );
    await tool(token, 'browser_cdp', { session_id: id, method: 'Runtime.evaluate', params: { expression: 'hunter2' } });
    // Another agent reopening this computer is refused, and its record does not link the session.
    expect(
      (await tool(other, 'computer_open', { computer_id: opened.computer_id })).result.structuredContent.error,
    ).toBe('busy');
    fails.screenshot = true;
    await tool(token, 'computer_screenshot', { session_id: id });
    fails.screenshot = false;
    fails.connect = true;
    await tool(token, 'computer_screenshot', { session_id: id });
    await tool(token, 'computer_screenshot', { session_id: 'cs_unknown' });
    const rows = await db.select().from(schema.toolCalls).orderBy(schema.toolCalls.id);
    expect(rows.map(row => [row.tool, row.error, row.failedStep, row.errorClass])).toEqual([
      ['account_identity', null, null, null],
      ['computer_open', null, null, null],
      ['computer_act', null, null, null],
      ['computer_exec', null, null, null],
      ['browser_cdp', 'tool_error', 'cdp', null],
      ['computer_open', 'busy', null, null],
      ['computer_screenshot', 'computer_unavailable', 'screenshot', 'TimeoutError'],
      ['computer_screenshot', 'computer_unavailable', 'connect', 'Error'],
      ['computer_screenshot', 'session_not_found', null, null],
    ]);
    const [session] = await db.select().from(schema.computerSessions);
    expect(rows.map(row => row.computerSessionId)).toEqual([
      null,
      ...Array(4).fill(session!.id),
      null,
      session!.id,
      session!.id,
      null,
    ]);
    const { membershipId } = await member(a.id);
    expect(rows.every(row => row.membershipId === membershipId && row.endedAt >= row.startedAt)).toBe(true);
    expect(session!.membershipId).toBe(membershipId);
    expect(JSON.stringify(rows)).not.toContain('hunter2');
  });
  it('prunes expired call records and keeps tools working when one cannot be written', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = await identity('a');
    const client = await register();
    const token = (await authorize(a.cookie, client))!.access_token;
    const day = 24 * 3600_000;
    const { membershipId } = await member(a.id);
    const record = (daysAgo: number) => ({
      membershipId,
      clientId: client,
      tool: 'account_identity',
      startedAt: new Date(Date.now() - daysAgo * day),
      endedAt: new Date(Date.now() - daysAgo * day),
    });
    await db.insert(schema.toolCalls).values([record(91), record(89)]);
    // Reading the body waits for the call to end, and so for its record.
    expect((await rpc(await call(token))).result.isError).toBe(false);
    const kept = await db.select({ startedAt: schema.toolCalls.startedAt }).from(schema.toolCalls);
    expect(kept.map(row => Math.round((Date.now() - row.startedAt.getTime()) / day))).toEqual([89, 0]);
    await pg.exec('DROP TABLE tool_calls');
    expect((await rpc(await call(token))).result.structuredContent.account_email).toBe('a@example.test');
    expect(errors.mock.calls.flat().join('\n')).toContain('tool call record failed');
  });
  it.runIf(process.env.LIVE_E2B === '1')(
    'drives a real E2B computer through MCP',
    async () => {
      vi.unstubAllGlobals();
      const passthrough = globalThis.fetch;
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        return req.url === `${origin}/api/auth/jwks` ? auth.handler(req) : passthrough(input, init);
      });
      vi.stubEnv('CAPTURE_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
      const provider = e2bComputerProvider();
      endpoint = createMcpEndpoint({ db, auth, origin, computers: provider });
      const a = await identity('a');
      const token = (await authorize(a.cookie, await register()))!.access_token;
      try {
        const opened = await tool(token, 'computer_open', {});
        expect(opened.result.isError).toBe(false);
        expect(opened.result.content[0].data.length).toBeGreaterThan(10_000);
        const id = opened.result.structuredContent.session_id;
        // How computer_open tells agents to open a page.
        await tool(token, 'computer_act', {
          session_id: id,
          actions: [
            { type: 'key', keys: ['ctrl', 'l'] },
            { type: 'type', text: 'https://example.com' },
            { type: 'key', keys: 'enter' },
            { type: 'wait', ms: 3000 },
          ],
        });
        const targets = await tool(token, 'browser_cdp', { session_id: id, method: 'Target.getTargets' });
        const page = targets.result.structuredContent.result.targetInfos.find((target: { url: string }) =>
          target.url.includes('example.com'),
        );
        const title = await tool(token, 'browser_cdp', {
          session_id: id,
          method: 'Runtime.evaluate',
          params: { expression: 'document.title', returnByValue: true },
          target_id: page.targetId,
        });
        expect(title.result.structuredContent.result.result.value).toBe('Example Domain');
        expect(
          (
            await tool(token, 'computer_act', {
              session_id: id,
              actions: [
                { type: 'click', x: 640, y: 400 },
                { type: 'scroll', direction: 'down', amount: 2 },
              ],
            })
          ).result.structuredContent,
        ).toMatchObject({ completed: 2 });
        expect(
          (
            await tool(token, 'computer_exec', {
              session_id: id,
              command: 'printf ok > /home/user/Downloads/live.txt && whoami',
            })
          ).result.structuredContent,
        ).toMatchObject({ exit_code: 0, stdout: 'user\n' });
        // Live view's stream: the relay, sending the Origin websockify expects, gets the VNC greeting; a
        // page in the computer's own Chrome, which reaches the port on loopback, sends its own Origin and is refused.
        const [running] = await db.select().from(schema.computers);
        const stream = await (await provider.connect(running!.sandboxId!, 60_000)).stream(15_000);
        const greeting = await new Promise<string>((resolve, reject) => {
          const socket = new WebSocket(stream.url, 'binary', { headers: stream.headers });
          socket.once('message', data => {
            resolve(String(data));
            socket.terminate();
          });
          socket.once('error', reject);
        });
        expect(greeting).toBe('RFB 003.008\n');
        const fromPage = await tool(token, 'computer_exec', {
          session_id: id,
          command:
            "curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://example.com' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' http://127.0.0.1:6080/",
        });
        expect(fromPage.result.structuredContent).toMatchObject({ exit_code: 0, stdout: '403' });
        const link = (await tool(token, 'computer_download', { session_id: id, path: '/home/user/Downloads/live.txt' }))
          .result.structuredContent.url;
        expect(await (await passthrough(link)).text()).toBe('ok');
        // A host sign-in mid-session is announced, not applied; reopening with the session_id applies it.
        await saveFromBrowser(
          db,
          await member(a.id),
          bundle([cookie({ domain: 'example.com', value: 'host-signed-in' })]),
        );
        const noticed = await tool(token, 'computer_screenshot', { session_id: id });
        expect(noticed.result.structuredContent.pending_sync).toMatchObject({ sites: ['example.com'] });
        const reopened = (await tool(token, 'computer_open', { session_id: id })).result.structuredContent;
        expect(reopened.browser_sync).toContain('1 site updated');
        const jar = await tool(token, 'browser_cdp', { session_id: reopened.session_id, method: 'Storage.getCookies' });
        expect(jar.result.structuredContent.result.cookies).toContainEqual(
          expect.objectContaining({ name: 'sid', domain: 'example.com', value: 'host-signed-in' }),
        );
        expect((await tool(token, 'computer_screenshot', { session_id: id })).result.structuredContent.error).toBe(
          'session_ended',
        );
        const closed = (await tool(token, 'computer_close', { session_id: reopened.session_id })).result
          .structuredContent;
        expect(closed).toMatchObject({ closed: true });
        const [computer] = await db.select().from(schema.computers);
        const info = await passthrough(`https://api.e2b.app/sandboxes/${computer!.sandboxId}`, {
          headers: { 'X-API-Key': process.env.E2B_API_KEY ?? '' },
        });
        expect((await info.json()).state).toBe('paused');
        // A second agent is busy while the first holds control, and takes over after its idle minute.
        const other = (await authorize(a.cookie, await register()))!.access_token;
        const held = (await tool(token, 'computer_open', {})).result.structuredContent.session_id;
        expect((await tool(other, 'computer_open', {})).result.structuredContent.error).toBe('busy');
        await new Promise(resolve => setTimeout(resolve, 62_000));
        const taken = (await tool(other, 'computer_open', {})).result.structuredContent.session_id;
        expect(taken).toMatch(SESSION_ID_PATTERN);
        expect((await tool(token, 'computer_screenshot', { session_id: held })).result.structuredContent.error).toBe(
          'session_ended',
        );
        expect((await tool(other, 'computer_close', { session_id: taken })).result.isError).toBe(false);
      } finally {
        await deleteMainComputer(db, provider, await member(a.id));
      }
    },
    360_000,
  );
});

describe('agent connections and setup', () => {
  const tool = (token: string, name: string, args: Record<string, unknown> = {}) =>
    call(token, 'tools/call', { name, arguments: args }).then(rpc);
  // The OAuth client whose computer session is live, if any.
  const holder = async () =>
    (await db.select().from(schema.computerSessions).where(isNull(schema.computerSessions.endedAt)))[0]?.clientId ??
    null;
  const setup = async (userId: string) =>
    (
      await db
        .select()
        .from(schema.setups)
        .where(eq(schema.setups.membershipId, (await member(userId)).membershipId))
    )[0];
  function web(cookie: string) {
    const api = createApi({ db, auth, origin, computers: fakeComputerProvider().provider });
    return (method: string, path: string, body?: unknown, from = origin) =>
      api.request(`${origin}/api/v1${path}`, {
        method,
        headers: { cookie, origin: from, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      });
  }
  it('disconnects one agent without touching other agents, other users, or the shared client', async () => {
    const fake = fakeComputerProvider();
    endpoint = createMcpEndpoint({ db, auth, origin, computers: fake.provider });
    const a = await identity('a');
    const b = await identity('b');
    const [x, y] = [await register(), await register()];
    const ax = (await authorize(a.cookie, x))!.access_token;
    const ay = (await authorize(a.cookie, y))!.access_token;
    const bx = (await authorize(b.cookie, x))!.access_token;
    expect((await tool(ax, 'computer_open')).result.isError).toBe(false);
    const request = web(a.cookie);
    // Each grant shows its last use of this account's computer; one that never used it shows null.
    const [session] = await db.select().from(schema.computerSessions);
    expect(
      Object.fromEntries(
        (await (await request('GET', '/mcp/grants')).json()).grants.map(
          (grant: { clientId: string; lastUsedAt: string | null }) => [grant.clientId, grant.lastUsedAt],
        ),
      ),
    ).toEqual({ [x]: session!.lastCallAt.toISOString(), [y]: null });
    expect(
      (await (await web(b.cookie)('GET', '/mcp/grants')).json()).grants.map(
        (grant: { lastUsedAt: string | null }) => grant.lastUsedAt,
      ),
    ).toEqual([null]);
    expect((await request('POST', '/mcp/grants/revoke', { clientId: y })).status).toBe(200);
    expect((await call(ay)).status).toBe(401);
    expect((await call(ax)).status).toBe(200);
    expect((await call(bx)).status).toBe(200);
    // Revoking an agent that does not hold the computer leaves the holder in control.
    expect(await holder()).toBe(x);
    expect((await request('POST', '/mcp/grants/revoke', { clientId: x })).status).toBe(200);
    expect(await holder()).toBeNull();
    expect((await db.select().from(schema.computerSessions))[0]).toMatchObject({ clientId: x, endReason: 'revoked' });
    expect((await call(ax)).status).toBe(401);
    expect((await call(bx)).status).toBe(200);
    expect(await db.select().from(schema.oauthClient)).toHaveLength(2);
    const missing = await request('POST', '/mcp/grants/revoke', { clientId: x });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
    for (const body of [
      undefined,
      'not json',
      {},
      { clientId: '' },
      { clientId: x, all: true },
      { clientId: 'x'.repeat(2049) },
    ])
      expect((await request('POST', '/mcp/grants/revoke', body)).status, JSON.stringify(body)).toBe(400);
    expect((await request('POST', '/mcp/grants/revoke', { clientId: x }, 'https://evil.test')).status).toBe(403);
  });
  it('binds each grant to one organization, and acts, lists, and revokes only there', async () => {
    const fake = fakeComputerProvider();
    endpoint = createMcpEndpoint({ db, auth, origin, computers: fake.provider });
    const a = await identity('a');
    const home = await member(a.id);
    const [x, y] = [await register(), await register()];
    const ax = (await authorize(a.cookie, x))!;
    const [consent] = await db.select().from(schema.oauthConsent);
    expect(consent!.referenceId).toBe(await membershipOf(a.id));
    const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    expect(claims(ax.access_token).membership).toBe(consent!.referenceId);
    // The person joins a second organization and switches to it, so their next consent is for it; its tokens keep it
    // when refreshed, and switching back doesn't move the grant.
    const team = await db.transaction(tx =>
      createOrganization(tx, { name: 'Team', owner: { id: a.id, name: 'A', email: 'a@example.test' } }),
    );
    const [inTeam] = await db
      .select()
      .from(schema.memberships)
      .where(and(eq(schema.memberships.userId, a.id), eq(schema.memberships.organizationId, team!)));
    await switchTo(db, a.id, team!);
    const ay = (await authorize(a.cookie, y))!;
    expect(claims(ay.access_token).membership).toBe(inTeam!.publicId);
    await switchTo(db, a.id, home.organizationId);
    const refreshed = await authRequest('/oauth2/token', {
      body: { grant_type: 'refresh_token', client_id: y, refresh_token: ay.refresh_token, resource },
    });
    expect(refreshed.status).toBe(200);
    const teamToken = ((await refreshed.json()) as { access_token: string }).access_token;
    expect(claims(teamToken).membership).toBe(inTeam!.publicId);
    // Each grant reaches its own organization's computer.
    for (const token of [ax.access_token, teamToken])
      expect((await tool(token, 'computer_open', {})).result.isError).toBe(false);
    expect(fake.calls.create).toBe(2);
    const sessions = () =>
      db
        .select({
          clientId: schema.computerSessions.clientId,
          membershipId: schema.computerSessions.membershipId,
          endReason: schema.computerSessions.endReason,
        })
        .from(schema.computerSessions)
        .orderBy(asc(schema.computerSessions.id));
    expect(await sessions()).toEqual([
      { clientId: x, membershipId: home.membershipId, endReason: null },
      { clientId: y, membershipId: inTeam!.id, endReason: null },
    ]);
    // A token naming a membership its grant is not for, another person's, or none, acts nowhere.
    const b = await identity('b');
    const iat = Math.floor(Date.now() / 1000) + 1;
    for (const membership of [consent!.referenceId, await membershipOf(b.id), 42, undefined])
      expect(await liveMcpPrincipal(db, { sub: a.id, client_id: y, iat, membership }), String(membership)).toBeNull();
    // The account page acts in the person's current organization: it lists and disconnects only that one's agents.
    const request = web(a.cookie);
    expect(
      (await (await request('GET', '/mcp/grants')).json()).grants.map((grant: { clientId: string }) => grant.clientId),
    ).toEqual([x]);
    expect((await request('POST', '/mcp/grants/revoke', { clientId: y })).status).toBe(404);
    expect((await request('POST', '/mcp/revoke')).status).toBe(200);
    expect((await call(ax.access_token)).status).toBe(401);
    expect((await call(teamToken)).status).toBe(200);
    expect(await sessions()).toEqual([
      { clientId: x, membershipId: home.membershipId, endReason: 'revoked' },
      { clientId: y, membershipId: inTeam!.id, endReason: null },
    ]);
    // Leaving an organization ends the grants made there.
    await db.delete(schema.memberships).where(eq(schema.memberships.id, inTeam!.id));
    expect((await call(teamToken)).status).toBe(401);
  });
  it('lists one row per connected client, flags disabled clients, and names known agents by client_id', async () => {
    const a = await identity('a');
    const b = await identity('b');
    const claudeCode = await register('https://claude.ai/oauth/claude-code-client-metadata');
    const other = await register();
    await authorize(a.cookie, claudeCode);
    await authorize(a.cookie, claudeCode);
    // An older consent for the same client is not listed again.
    await db.insert(schema.oauthConsent).values({
      id: randomUUID(),
      clientId: claudeCode,
      userId: a.id,
      referenceId: await membershipOf(a.id),
      scopes: ['mcp:tools'],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await authorize(b.cookie, other);
    // A client registered outside CIMD (no URL) is listed as another agent.
    await db.insert(schema.oauthClient).values({ id: randomUUID(), clientId: 'browser-fixture-1', redirectUris: [] });
    await db.insert(schema.oauthConsent).values({
      id: randomUUID(),
      clientId: 'browser-fixture-1',
      userId: a.id,
      referenceId: await membershipOf(a.id),
      scopes: ['openid', 'mcp:tools'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const listed = (await (await web(a.cookie)('GET', '/mcp/grants')).json()).grants;
    expect(listed).toEqual([
      expect.objectContaining({
        clientId: claudeCode,
        host: 'claude.ai',
        agent: 'claude-code',
        disabled: false,
        mcp: true,
      }),
      expect.objectContaining({ clientId: 'browser-fixture-1', host: null, agent: null, disabled: false }),
    ]);
    expect(listed[0].name).toBe('Fixture agent');
    await db.update(schema.oauthClient).set({ disabled: true }).where(eq(schema.oauthClient.clientId, other));
    const forB = web(b.cookie);
    expect((await (await forB('GET', '/mcp/grants')).json()).grants).toEqual([
      expect.objectContaining({ clientId: other, agent: null, host: 'client.example.test', disabled: true }),
    ]);
    expect((await (await forB('GET', '/setup')).json()).items.agents).toBe(false);
    expect((await (await web(a.cookie)('GET', '/setup')).json()).items.agents).toBe(true);
  });
  it('lists a client that holds only account info so it can be disconnected, without counting it as an agent', async () => {
    const a = await identity('a');
    const client = 'https://client.example.test/account-info.json';
    await db.insert(schema.oauthClient).values({ id: randomUUID(), clientId: client, redirectUris: [] });
    await db.insert(schema.oauthConsent).values({
      id: randomUUID(),
      clientId: client,
      userId: a.id,
      referenceId: await membershipOf(a.id),
      scopes: ['openid', 'profile', 'offline_access'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const request = web(a.cookie);
    expect((await (await request('GET', '/mcp/grants')).json()).grants).toEqual([
      expect.objectContaining({ clientId: client, mcp: false, disabled: false }),
    ]);
    expect((await (await request('GET', '/setup')).json()).items.agents).toBe(false);
    expect((await request('POST', '/mcp/grants/revoke', { clientId: client })).status).toBe(200);
    expect((await (await request('GET', '/mcp/grants')).json()).grants).toEqual([]);
    expect(await db.select().from(schema.oauthConsent)).toEqual([]);
  });
  it('never lets a call that was in flight during a disconnect take the computer', async () => {
    // One provider, so its snapshot IDs stay unique in the database.
    const fake = fakeComputerProvider();
    for (const [user, revoke] of [
      ['a', async (userId: string, client: string) => revokeMcpGrant(db, await member(userId), client)],
      ['b', async (userId: string) => revokeMcpGrants(db, await member(userId))],
    ] as const) {
      // The open has passed its grant check and is creating the computer when the user disconnects it.
      let creating!: () => void;
      const started = new Promise<void>(resolve => {
        creating = resolve;
      });
      let release!: () => void;
      const revoked = new Promise<void>(resolve => {
        release = resolve;
      });
      const provider = {
        ...fake.provider,
        async create(computerId: string, timeoutMs: number) {
          creating();
          await revoked;
          return fake.provider.create(computerId, timeoutMs);
        },
      };
      endpoint = createMcpEndpoint({ db, auth, origin, computers: provider });
      const { id, cookie } = await identity(user);
      const client = await register();
      const token = (await authorize(cookie, client))!.access_token;
      const open = tool(token, 'computer_open');
      await started;
      await revoke(id, client);
      release();
      expect((await open).result.structuredContent.error, user).toBe('access_revoked');
      expect(
        await db
          .select()
          .from(schema.computerSessions)
          .where(eq(schema.computerSessions.membershipId, (await member(id)).membershipId)),
        user,
      ).toEqual([]);
    }
  });
  it('records set-up once when an agent opens the computer, and never on a failed open', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fake = fakeComputerProvider();
    endpoint = createMcpEndpoint({ db, auth, origin, computers: fake.provider });
    const a = await identity('a');
    const client = await register();
    const token = (await authorize(a.cookie, client))!.access_token;
    const [consent] = await db.select().from(schema.oauthConsent);
    expect((await call(token)).status).toBe(200);
    expect((await setup(a.id))?.agentConnectedAt).toEqual(consent!.createdAt);
    // Another agent holds a computer: this open of it fails, so the user is not set up.
    await db.insert(schema.oauthClient).values({ id: 'other-agent', clientId: 'other-agent', redirectUris: [] });
    const other = await openComputerSession(
      db,
      { provider: fake.provider, metering: noMetering },
      { ...(await member(a.id)), clientId: 'other-agent' },
    );
    if ('error' in other) throw new Error(other.error);
    await other.done();
    const computer_id = other.computer.id;
    expect((await tool(token, 'computer_open', { computer_id })).result.structuredContent.error).toBe('busy');
    expect((await setup(a.id))?.setUpAt).toBeNull();
    // The other agent's idle minute passes: one of these concurrent opens takes over, the rest find it busy.
    await db.update(schema.computerSessions).set({ lastCallAt: new Date(Date.now() - 61_000) });
    const opened = await Promise.all([1, 2, 3].map(() => tool(token, 'computer_open', { computer_id })));
    const started = opened.filter(response => response.result.isError === false);
    expect(started).toHaveLength(1);
    expect(opened.filter(response => response.result.structuredContent.error === 'busy')).toHaveLength(2);
    expect(
      (await tool(token, 'computer_open', { session_id: started[0]!.result.structuredContent.session_id })).result
        .isError,
    ).toBe(false);
    expect((await setup(a.id))?.setUpAt).toBeInstanceOf(Date);
    expect(logged.mock.calls.map(([line]) => JSON.parse(line).event)).toEqual(['setup.agentConnected', 'setup.setUp']);
  });
  it('keeps tools working when setup progress cannot be written', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = fakeComputerProvider();
    endpoint = createMcpEndpoint({ db, auth, origin, computers: fake.provider });
    const a = await identity('a');
    const token = (await authorize(a.cookie, await register()))!.access_token;
    await pg.exec('DROP TABLE setups');
    expect((await call(token)).status).toBe(200);
    const opened = await tool(token, 'computer_open');
    expect(opened.result.isError).toBe(false);
    expect(opened.result.structuredContent.session_id).toMatch(SESSION_ID_PATTERN);
    expect(errors.mock.calls.flat().join('\n')).toContain('setup setUp failed');
  });
});
