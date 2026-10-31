import { createHmac, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serverProofPath } from '@clutchbox/capture';
import type { Database } from '@clutchbox/server/database';
import { databaseSchema } from '@clutchbox/server/database-schema';
import { defaultServerHooks } from '@clutchbox/server/hooks';
import { migrationsFolder } from '@clutchbox/server/migrator';
import * as schema from '@clutchbox/server/schema';
import { PGlite } from '@electric-sql/pglite';
import { upgradeWebSocket } from '@vercel/functions';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { apiHandler, apiServer } from './api-server';
import { apiGet, httpApi, type Me } from './lib/page-api';
import { createServices } from './services';

// The API's own server, built from the no-op defaults, on a PGlite database instead of the pool.
let db: Database;
vi.mock('@clutchbox/server/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@clutchbox/server/database')>()),
  createDatabase: () => ({ db, pool: undefined }),
}));
// The CDP proxy, with one stand-in session that upgrades and echoes, so an upgrade that succeeds runs through the
// server without a computer behind it. Every other request reaches the real proxy.
const ECHO = 'echo-synthetic';
vi.mock('@clutchbox/api/cdp', async importOriginal => {
  const real = await importOriginal<typeof import('@clutchbox/api/cdp')>();
  return {
    ...real,
    cdpHandler: (deps: Parameters<typeof real.cdpHandler>[0]) => (request: Request) =>
      new URL(request.url).searchParams.get('token') === ECHO
        ? upgradeWebSocket(socket => {
            socket.on('message', data => socket.send(data));
          })
        : real.cdpHandler(deps)(request),
  };
});

// The page's request, for httpApi: the visitor's cookie and address, as the platform passes them.
const visitor = { cookie: '', address: '' };
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ cookie: visitor.cookie, 'x-forwarded-for': visitor.address }),
}));

const origin = 'http://localhost:3000';
const extension = `chrome-extension://${'a'.repeat(32)}`;
const secret = randomBytes(32).toString('base64url');
let pg: PGlite;
let template: PGlite;
let server: Server | undefined;
beforeAll(async () => {
  template = new PGlite();
  await migrate(drizzle(template, { schema: databaseSchema }), { migrationsFolder });
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  db = drizzle(pg, { schema: databaseSchema }) as unknown as Database;
  await db.insert(schema.installation).values({ dataClass: 'nonproduction' });
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://localhost/synthetic');
  vi.stubEnv('BETTER_AUTH_URL', origin);
  vi.stubEnv('BETTER_AUTH_SECRET', secret);
  vi.stubEnv('GOOGLE_CLIENT_ID', 'synthetic.apps.googleusercontent.com');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'synthetic-only');
  vi.stubEnv('E2B_API_KEY', '');
  vi.stubEnv('EXTENSION_ORIGINS', extension);
});
afterEach(async () => {
  await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
  vi.unstubAllEnvs();
  await pg.close();
});

// A signed-in person's session cookie, as Better Auth sets it.
async function signedIn() {
  const { auth } = await createServices(defaultServerHooks)();
  await db.insert(schema.user).values({ id: 'a', name: 'a', email: 'a@example.test', emailVerified: true });
  const token = randomBytes(32).toString('base64url');
  await db
    .insert(schema.session)
    .values({ id: crypto.randomUUID(), userId: 'a', token, expiresAt: new Date(Date.now() + 3600_000) });
  const signature = createHmac('sha256', secret).update(token).digest('base64');
  return `${(await auth.$context).authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
}

describe('the API server', () => {
  it("answers the manifest's API routes as Next.js does, and nothing of the web app's", async () => {
    const handle = apiHandler(createServices(defaultServerHooks));
    const request = (path: string, init?: RequestInit) => handle(new Request(`${origin}${path}`, init));

    const health = await request('/api/health');
    expect([health.status, await health.json()]).toEqual([200, { status: 'ok' }]);
    expect(health.headers.get('x-frame-options')).toBe('DENY');
    const head = await request('/api/health', { method: 'HEAD' });
    expect([head.status, await head.text()]).toEqual([200, '']);
    expect(await (await request('/api/v1/sign-in-methods')).json()).toMatchObject({ providers: ['google'] });
    expect(await (await request(serverProofPath)).json()).toEqual({ origin, api: origin });
    expect((await request('/oauth/extension-client.json')).status).toBe(200);
    const signIn = await request('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: '/app' }),
    });
    expect((await signIn.json()).url).toMatch(/^https:\/\/accounts\.google\.com\//);
    // The token endpoint's preflight is its own handler, which answers the extension.
    const preflight = await request('/api/auth/oauth2/token', { method: 'OPTIONS', headers: { origin: extension } });
    expect(preflight.headers.get('access-control-allow-origin')).toBe(extension);
    // The relays and MCP, on their own routes ahead of the API's catch-all, refuse a request without credentials.
    for (const path of ['/api/v1/cdp', '/api/v1/live-view']) expect((await request(path)).status, path).toBe(401);
    const mcp = await request('/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(mcp.status).toBe(401);

    const wrong = await request('/api/health', { method: 'DELETE' });
    expect([wrong.status, wrong.headers.get('allow')]).toEqual([405, 'GET, HEAD, OPTIONS']);
    expect((await request('/api/health', { method: 'OPTIONS' })).status).toBe(204);
    const root = await request('/');
    expect([root.status, root.headers.get('location')]).toEqual([302, '/api/health']);
    for (const path of ['/app', '/sign-in', '/downloads/agent-computers-extension.zip'])
      expect((await request(path)).status, path).toBe(404);
  });

  it('serves HTTP with its cookies and bodies, and WebSocket upgrades, over Node', async () => {
    const cookie = await signedIn();
    server = apiServer(createServices(defaultServerHooks));
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
    const at = `127.0.0.1:${(server.address() as AddressInfo).port}`;

    const me = await fetch(`http://${at}/api/v1/me`, { headers: { origin, cookie } });
    expect([me.status, (await me.json()).user.email]).toEqual([200, 'a@example.test']);
    const signIn = await fetch(`http://${at}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: '/app' }),
    });
    expect(signIn.status).toBe(200);

    // A refusal is an HTTP answer on the socket; an upgrade hands the socket to the route.
    const refused = await new Promise<number | undefined>((resolve, reject) => {
      const socket = new WebSocket(`ws://${at}/api/v1/cdp`);
      socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
      socket.once('error', reject);
    });
    expect(refused).toBe(401);
    const socket = new WebSocket(`ws://${at}/api/v1/cdp?token=${ECHO}`);
    await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));
    socket.send('ping');
    const echoed = await new Promise(resolve => socket.once('message', data => resolve(String(data))));
    expect(echoed).toBe('ping');
    socket.close();
  });

  it("serves the pages' reads over HTTP as the visitor, with their address when the secret is shared", async () => {
    visitor.cookie = await signedIn();
    visitor.address = '203.0.113.5, 192.0.2.1';
    const forwardedSecret = randomBytes(32).toString('base64url');
    server = apiServer(createServices(defaultServerHooks), { forwardedSecret });
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const me = await apiGet<Me>(httpApi(at, { forwardedSecret }), '/me');
    expect(me.ok && me.data.user.email).toBe('a@example.test');
    // Signed out, the page gets the status to branch on.
    visitor.cookie = '';
    expect(await apiGet<Me>(httpApi(at), '/me')).toEqual({ ok: false, status: 401 });
  });
});
