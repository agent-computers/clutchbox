import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { builtInVerifiedServers } from '@agent-computers/capture';
import { databaseSchema } from '@agent-computers/server/database-schema';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../../server/src/auth';
import { connectBrowser, type Tokens } from '../../server/src/browser-fixtures';
import { ensureExtensionClient } from '../../server/src/browsers';
import { bundle, cookie, siteBundle } from '../../server/src/capture-fixtures';
import { adoptSyncSettings, captureView, saveCapture, syncView } from '../../server/src/captures';
import type { ComputerProvider } from '../../server/src/computers';
import { openComputerSession } from '../../server/src/computers';
import type { ServerConfig } from '../../server/src/config';
import type { Database } from '../../server/src/database';
import { fakeComputerProvider } from '../../server/src/fake-computer-provider';
import { type MeteringRefusal, noMetering, noOperatorAdmin } from '../../server/src/hooks';
import { inTheOrganization, membership } from '../../server/src/member-fixtures';
import { createOrganization, currentMember } from '../../server/src/organizations';
import * as schema from '../../server/src/schema';
import { recordSetupStep, setupView } from '../../server/src/setup';
import { createApi } from './index';

// Every /api/v1 route over HTTP, in process: session, origin, validation, status codes, and ownership.
// The services behind them are tested in packages/server; this covers the route layer on top.
const origin = 'http://localhost:3099';
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
let fake: ReturnType<typeof fakeComputerProvider>;
async function identity(id: string) {
  const person = { id, name: `Fixture ${id}`, email: `${id}@example.test` };
  await db.insert(schema.user).values({ ...person, emailVerified: true });
  // Into the deployment's organization, as sign-up does.
  await inTheOrganization(db, person);
  const token = randomBytes(32).toString('base64url');
  await db
    .insert(schema.session)
    .values({ id: randomUUID(), userId: id, token, expiresAt: new Date(Date.now() + 3600_000) });
  const signature = createHmac('sha256', config.BETTER_AUTH_SECRET).update(token).digest('base64');
  return `${(await auth.$context).authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
}
function client(
  computers: ComputerProvider = fake.provider,
  options: Omit<Parameters<typeof createApi>[0], 'db' | 'auth' | 'origin' | 'computers'> = {},
) {
  const api = createApi({ db, auth, origin, computers, ...options });
  return (
    method: string,
    path: string,
    {
      cookie,
      token,
      from = token ? extension : origin,
      body,
      version,
    }: { cookie?: string; token?: Tokens; from?: string | null; body?: unknown; version?: string } = {},
  ) =>
    api.request(`${origin}/api/v1${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(token ? { authorization: `Bearer ${token.access_token}` } : {}),
        ...(version ? { 'x-extension-version': version } : {}),
        ...(from ? { origin: from } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
}
// The extension's connection for a signed-in user: uploads and its settings changes take its token.
const browser = (cookie: string) => connectBrowser(auth, cookie, { extensionOrigin: extension });
// Migrate once per file and give each test a clone, which is much faster than a new database.
// The member a person acts as, which the routes resolve from the session.
const member = async (userId: string) => (await currentMember(db, userId))!;
let template: PGlite;
beforeAll(async () => {
  template = new PGlite();
  const templateDb = drizzle(template, { schema: databaseSchema });
  await migrate(templateDb, { migrationsFolder: fileURLToPath(new URL('../../server/migrations', import.meta.url)) });
  await ensureExtensionClient(templateDb as unknown as Database, extension);
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  const embedded = drizzle(pg, { schema: databaseSchema });
  db = embedded as unknown as Database;
  await db.insert(schema.installation).values({ dataClass: 'nonproduction' });
  auth = createAuth(db, config);
  await auth.$context;
  fake = fakeComputerProvider();
  // Computer sessions reference their OAuth client.
  await db.insert(schema.oauthClient).values({ id: 'agent-client', clientId: 'agent-client', redirectUris: [] });
  vi.stubEnv('CAPTURE_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('EXTENSION_ORIGINS', extension);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await pg.close();
});

describe('API routes', () => {
  it('require a session on every route and the web origin on every change', async () => {
    const request = client();
    const a = await identity('a');
    const routes = [
      ['GET', '/me'],
      ['GET', '/mcp/grants'],
      ['POST', '/mcp/revoke'],
      ['POST', '/mcp/grants/revoke'],
      ['GET', '/setup'],
      ['POST', '/setup/notice/close'],
      ['PUT', '/time-zone'],
      ['GET', '/computer'],
      ['DELETE', '/computer'],
      ['POST', '/computer/reset'],
      ['POST', '/computer/takeover'],
      ['POST', '/computer/hand-back'],
      ['POST', '/computer/clipboard'],
      ['POST', '/heartbeat'],
      ['POST', '/captures'],
      ['DELETE', '/captures'],
      ['GET', '/sync'],
      ['PATCH', '/sync'],
      ['POST', '/sync/adopt'],
      ['POST', '/sync/disconnect'],
      ['GET', '/browsers'],
      ['POST', '/browsers/disconnect'],
    ] as const;
    for (const [method, path] of routes) {
      expect((await request(method, path)).status, `${method} ${path} without a session`).toBe(401);
      if (method === 'GET') continue;
      for (const from of ['https://evil.test', `${origin}.evil.test`, null])
        expect((await request(method, path, { cookie: a, from })).status, `${method} ${path} from ${from}`).toBe(403);
    }
    // From the pinned extension, only a sync token works (extension-oauth.test.ts): on the extension's routes, the web
    // session gets an update prompt, and other changes are refused.
    for (const [method, path] of routes)
      if (method !== 'GET')
        expect((await request(method, path, { cookie: a, from: extension })).status, `${method} ${path}`).toBe(
          ['/captures', '/sync', '/sync/adopt'].includes(path) ? 426 : 403,
        );
  });

  it("run a deployment's extension routes behind the same session, origin, and headers, without shadowing product routes", async () => {
    const request = client(fake.provider, {
      extend: app => {
        app.put('/extra', c => c.json({ user: c.get('principal').id }));
        app.get('/me', c => c.json({ shadowed: true }));
      },
    });
    const a = await identity('a');
    expect((await request('PUT', '/extra')).status).toBe(401);
    expect((await request('PUT', '/extra', { cookie: a, from: 'https://evil.test' })).status).toBe(403);
    const response = await request('PUT', '/extra', { cookie: a });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ user: 'a' });
    expect(await (await request('GET', '/me', { cookie: a })).json()).toMatchObject({ user: { id: 'a' } });
    expect((await client()('PUT', '/extra', { cookie: a })).status).toBe(404);
  });

  it('serve the verified servers to anyone, without a session, the same for everyone', async () => {
    const request = client();
    const a = await identity('a');
    for (const options of [{ from: null }, { from: extension }, { cookie: a }]) {
      const response = await request('GET', '/verified-servers', options);
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await response.json()).toEqual({ servers: builtInVerifiedServers });
    }
    expect((await request('POST', '/verified-servers', { cookie: a })).status).toBe(404);
  });

  it('accept capture uploads from a connected browser, reject malformed or oversized ones, and keep them per user', async () => {
    const request = client();
    const a = await identity('a');
    const b = await identity('b');
    const ta = await browser(a);
    const capture = bundle([cookie(), cookie({ name: 'other', domain: '.github.com', hostOnly: false })]);
    const stored = await request('POST', '/captures', { token: ta, body: { capture } });
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({ status: 'stored', cookieCount: 2 });
    expect((await request('POST', '/captures', { token: ta, body: { capture } })).status).toBe(200);
    expect(
      (await request('POST', '/captures', { token: ta, body: { capture: { ...capture, schemaVersion: 1 } } })).status,
    ).toBe(400);
    expect(
      (await request('POST', '/captures', { token: ta, body: { capture, excludedDomains: ['bank.test'] } })).status,
    ).toBe(400);
    // Builds from before site selection upload whole-browser captures, and both scopes stay accepted.
    const sites = { mode: 'sites', sites: ['example.com', 'github.com'], excludedDomains: [] };
    expect(
      (await request('POST', '/captures', { token: ta, body: { capture: { ...capture, scope: sites } } })).status,
    ).toBe(200);
    expect(
      (
        await request('POST', '/captures', {
          token: ta,
          body: { capture: { ...capture, scope: { ...sites, sites: ['example.com'] } } },
        })
      ).status,
    ).toBe(400);
    expect((await request('POST', '/captures', { token: ta, body: 'not json' })).status).toBe(400);
    expect(
      (await request('POST', '/captures', { token: ta, body: { capture, padding: 'x'.repeat(4_000_001) } })).status,
    ).toBe(413);
    expect((await (await request('GET', '/computer', { cookie: a })).json()).capture).toMatchObject({ cookieCount: 2 });
    expect((await (await request('GET', '/computer', { cookie: b })).json()).capture).toBeNull();
    // The extension deletes its upload on disconnect.
    expect((await request('DELETE', '/captures', { token: ta })).status).toBe(200);
    expect((await (await request('GET', '/computer', { cookie: a })).json()).capture).toBeNull();
    const reconnected = await browser(a);
    vi.stubEnv('CAPTURE_ENCRYPTION_KEY', '');
    expect((await request('POST', '/captures', { token: reconnected, body: { capture } })).status).toBe(503);
  });

  it('offer the latest extension build on upload, and tell builds older than the minimum to update', async () => {
    const a = await browser(await identity('a'));
    const capture = bundle([cookie()]);
    const current = client(fake.provider, { extensionVersion: '0.6.0' });
    expect(await (await current('POST', '/captures', { token: a, body: { capture } })).json()).toMatchObject({
      status: 'stored',
      latestVersion: '0.6.0',
    });
    const strict = client(fake.provider, { extensionVersion: '0.6.0', minExtensionVersion: '0.5.0' });
    for (const version of [undefined, '0.4.9']) {
      const refused = await strict('POST', '/captures', {
        token: a,
        body: { capture },
        ...(version ? { version } : {}),
      });
      expect(refused.status, version).toBe(426);
      expect(await refused.json()).toEqual({ error: 'extension_outdated', latestVersion: '0.6.0' });
    }
    expect((await strict('POST', '/captures', { token: a, body: { capture }, version: '0.5.0' })).status).toBe(200);
    // Authentication is still checked first.
    expect((await strict('POST', '/captures', { body: { capture }, version: '0.4.0' })).status).toBe(401);
  });

  it('Delete everything removes the computer and synced data, keeps sync off until the extension reconnects, and leaves other users alone', async () => {
    const request = client();
    const a = await identity('a');
    const b = await identity('b');
    const capture = bundle([cookie()]);
    for (const user of [a, b])
      expect((await request('POST', '/captures', { token: await browser(user), body: { capture } })).status).toBe(200);
    await openComputerSession(
      db,
      { provider: fake.provider, metering: noMetering },
      { ...(await member('a')), clientId: 'agent-client' },
    );
    const now = new Date();
    const [ma, mb] = [await member('a'), await member('b')];
    await db.insert(schema.toolCalls).values(
      [ma, mb].map(({ membershipId }) => ({
        membershipId,
        clientId: 'agent-client',
        tool: 'computer_open',
        startedAt: now,
        endedAt: now,
      })),
    );
    expect((await request('DELETE', '/computer', { cookie: a })).status).toBe(200);
    expect(
      (await db.select({ membershipId: schema.toolCalls.membershipId }).from(schema.toolCalls)).map(
        row => row.membershipId,
      ),
    ).toEqual([mb.membershipId]);
    expect(await (await request('GET', '/computer', { cookie: a })).json()).toMatchObject({
      capture: null,
      computer: null,
    });
    // The main computer and its fork, then the fork's snapshot.
    expect({ kill: fake.calls.kill, deleteSnapshot: fake.calls.deleteSnapshot }).toEqual({
      kill: 2,
      deleteSnapshot: 1,
    });
    expect((await (await request('GET', '/computer', { cookie: b })).json()).capture).toMatchObject({ cookieCount: 1 });
    // A browser connected since uploads only with `connect`, the first upload after Connect.
    const reconnected = await browser(a);
    const again = await request('POST', '/captures', { token: reconnected, body: { capture: bundle([cookie()]) } });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'sync_disconnected' });
    expect(
      (await request('POST', '/captures', { token: reconnected, body: { capture: bundle([cookie()]), connect: true } }))
        .status,
    ).toBe(200);
  });

  it('let the extension adopt and change sync settings, and the account page only narrow them, per user', async () => {
    const request = client(fake.provider, { extensionVersion: '0.6.0' });
    const a = await identity('a');
    const b = await identity('b');
    const ta = await browser(a);
    const local = { sites: ['github.com', 'notion.so'], excludedDomains: ['bank.test'], paused: false };
    const body = async (response: Response) => ({ status: response.status, json: await response.json() });
    // The extension reads its config with the settings, before and after adoption.
    const empty = await body(await request('GET', '/sync', { cookie: a }));
    expect(empty).toMatchObject({ status: 200, json: { settings: null, disconnected: false, latestVersion: '0.6.0' } });
    expect(empty.json.config.suggestedSites.length).toBeGreaterThan(0);
    // Only the account page's narrowing works before adoption, and there is nothing to narrow yet.
    expect(await body(await request('PATCH', '/sync', { cookie: a, body: { removeSites: ['github.com'] } }))).toEqual({
      status: 409,
      json: { error: 'sync_settings_missing' },
    });
    // Adoption is the extension's alone, since it can add sites.
    expect((await request('POST', '/sync/adopt', { cookie: a, body: { settings: local } })).status).toBe(403);
    expect((await request('POST', '/sync/adopt', { token: ta, body: { settings: { sites: [] } } })).status).toBe(400);
    expect(await body(await request('POST', '/sync/adopt', { token: ta, body: { settings: local } }))).toEqual({
      status: 200,
      json: { settings: local },
    });
    // The account page may remove sites, edit exclusions, and pause, but not add sites or resume.
    for (const change of [{ addSites: ['x.com'] }, { paused: false }])
      expect(await body(await request('PATCH', '/sync', { cookie: a, body: change })), JSON.stringify(change)).toEqual({
        status: 403,
        json: { error: 'extension_only' },
      });
    expect((await request('PATCH', '/sync', { cookie: a, body: { removeSites: ['not a site'] } })).status).toBe(400);
    expect((await request('PATCH', '/sync', { cookie: a, body: { other: true } })).status).toBe(400);
    expect(
      await body(
        await request('PATCH', '/sync', {
          cookie: a,
          body: { removeSites: ['notion.so'], excludedDomains: [], paused: true },
        }),
      ),
    ).toEqual({ status: 200, json: { settings: { sites: ['github.com'], excludedDomains: [], paused: true } } });
    // The extension may add sites and resume.
    expect(
      await body(
        await request('PATCH', '/sync', {
          token: ta,
          body: { addSites: ['x.com', 'twitter.com'], paused: false },
        }),
      ),
    ).toEqual({
      status: 200,
      json: { settings: { sites: ['github.com', 'twitter.com', 'x.com'], excludedDomains: [], paused: false } },
    });
    // Uploads keep only allowed sites and answer with the settings.
    const capture = siteBundle(
      [cookie({ domain: 'github.com' }), cookie({ domain: 'notion.so' })],
      ['github.com', 'notion.so'],
    );
    expect(await body(await request('POST', '/captures', { token: ta, body: { capture } }))).toMatchObject({
      status: 200,
      json: { cookieCount: 1, settings: { sites: ['github.com', 'twitter.com', 'x.com'] } },
    });
    await request('PATCH', '/sync', { cookie: a, body: { paused: true } });
    expect(await body(await request('POST', '/captures', { token: ta, body: { capture } }))).toMatchObject({
      status: 409,
      json: { error: 'sync_paused', settings: { paused: true } },
    });
    // Each user sees only their own.
    expect((await body(await request('GET', '/sync', { cookie: b }))).json.settings).toBeNull();
    // Turning sync off on the account page keeps the settings and tells the extension.
    expect((await request('POST', '/sync/disconnect', { cookie: a })).status).toBe(200);
    expect((await body(await request('GET', '/sync', { cookie: a }))).json).toMatchObject({
      disconnected: true,
      settings: { sites: ['github.com', 'twitter.com', 'x.com'] },
    });
    expect((await (await request('GET', '/computer', { cookie: a })).json()).capture).toBeNull();
    // Delete everything forgets them.
    expect((await request('DELETE', '/computer', { cookie: a })).status).toBe(200);
    expect((await body(await request('GET', '/sync', { cookie: a }))).json.settings).toBeNull();
    const reconnected = await browser(a);
    vi.stubEnv('CAPTURE_ENCRYPTION_KEY', '');
    expect((await request('POST', '/sync/adopt', { token: reconnected, body: { settings: local } })).status).toBe(503);
    expect((await request('PATCH', '/sync', { cookie: a, body: { paused: true } })).status).toBe(503);
  });

  it('show each user their own setup checklist, and record browser sync once a site is added', async () => {
    const request = client();
    const a = await identity('a');
    const b = await identity('b');
    const setup = async (user: string) => (await request('GET', '/setup', { cookie: user })).json();
    expect(await setup(a)).toEqual({
      setUpAt: null,
      noticeOpen: false,
      items: { browserSync: false, agents: false, computer: false },
      sync: { mode: null, sites: [], readable: true },
    });
    // Agree with no site yet: synced, but nothing to list and the step is not done.
    const ta = await browser(a);
    const agreed = siteBundle([], []);
    expect((await request('POST', '/captures', { token: ta, body: { capture: agreed } })).status).toBe(200);
    expect((await setup(a)).items.browserSync).toBe(false);
    expect((await db.select().from(schema.setups)).filter(row => row.browserSyncedAt)).toHaveLength(0);
    // A site with no cookies yet: the cookie digest is unchanged, and the site still shows.
    const added = siteBundle([], ['github.com', 'notion.so']);
    expect(await (await request('POST', '/captures', { token: ta, body: { capture: added } })).json()).toMatchObject({
      status: 'unchanged',
    });
    expect(await setup(a)).toMatchObject({
      items: { browserSync: true },
      sync: { mode: 'sites', sites: ['github.com', 'notion.so'], readable: true },
    });
    expect((await db.select().from(schema.setups))[0]).toMatchObject({
      membershipId: (await member('a')).membershipId,
      browserSyncedAt: expect.any(Date),
    });
    expect((await setup(b)).items.browserSync).toBe(false);
    // The notice opens once set up, and closing it is per user and idempotent.
    for (const id of ['a', 'b']) await recordSetupStep(db, await member(id), 'setUp');
    expect(await setup(a)).toMatchObject({ noticeOpen: true, setUpAt: expect.any(String), items: { computer: true } });
    for (const _ of [1, 2]) {
      const closed = await request('POST', '/setup/notice/close', { cookie: a });
      expect(closed.status).toBe(200);
      expect(await closed.json()).toEqual({ closed: true });
    }
    expect((await setup(a)).noticeOpen).toBe(false);
    expect((await setup(b)).noticeOpen).toBe(true);
  });
  it('keep uploads answering when setup progress cannot be written', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = client();
    const a = await browser(await identity('a'));
    await pg.exec('DROP TABLE setups');
    const res = await request('POST', '/captures', {
      token: a,
      body: { capture: siteBundle([], ['github.com']) },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('stored');
    expect(errors.mock.calls.flat().join('\n')).toContain('setup browserSynced failed');
  });

  it('Delete everything resets set-up even when the provider fails, and keeps setup history', async () => {
    const a = await identity('a');
    const b = await identity('b');
    for (const id of ['a', 'b']) {
      await recordSetupStep(db, await member(id), 'browserSynced');
      await recordSetupStep(db, await member(id), 'setUp');
    }
    expect((await client()('DELETE', '/computer', { cookie: a })).status).toBe(200);
    expect(await (await client()('GET', '/setup', { cookie: a })).json()).toMatchObject({
      setUpAt: null,
      noticeOpen: false,
    });
    const [row] = await db
      .select()
      .from(schema.setups)
      .where(eq(schema.setups.membershipId, (await member('a')).membershipId));
    expect(row).toMatchObject({ setUpAt: null, browserSyncedAt: expect.any(Date), firstSetUpAt: expect.any(Date) });
    // A provider failure answers 503 after set-up is already reset.
    const request = client();
    await openComputerSession(
      db,
      { provider: fake.provider, metering: noMetering },
      { ...(await member('b')), clientId: 'agent-client' },
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = client({
      ...fake.provider,
      kill: async () => {
        throw new Error('provider down');
      },
    });
    expect((await failing('DELETE', '/computer', { cookie: b })).status).toBe(503);
    expect((await (await request('GET', '/setup', { cookie: b })).json()).setUpAt).toBeNull();
  });

  it('Reset computer replaces only the computer, keeping synced data, setup, and other users', async () => {
    const request = client();
    const a = await identity('a');
    const b = await identity('b');
    expect((await request('POST', '/computer/reset', { cookie: a })).status).toBe(404);
    for (const user of [a, b])
      expect(
        (await request('POST', '/captures', { token: await browser(user), body: { capture: bundle([cookie()]) } }))
          .status,
      ).toBe(200);
    for (const userId of ['a', 'b']) {
      await recordSetupStep(db, await member(userId), 'setUp');
      await openComputerSession(
        db,
        { provider: fake.provider, metering: noMetering },
        { ...(await member(userId)), clientId: 'agent-client' },
      );
    }
    const reset = await request('POST', '/computer/reset', { cookie: a });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ reset: true });
    // The main computer and the agent's fork.
    expect(fake.calls.kill).toBe(2);
    // The agent's session ends with its fork; the next open creates a fresh main computer.
    expect(await db.select().from(schema.computerSessions)).toHaveLength(1);
    expect(await (await request('GET', '/computer', { cookie: a })).json()).toMatchObject({
      capture: { cookieCount: 1 },
      computer: null,
    });
    expect((await (await request('GET', '/setup', { cookie: a })).json()).setUpAt).toEqual(expect.any(String));
    expect((await (await request('GET', '/computer', { cookie: b })).json()).computer).toMatchObject({
      status: 'ready',
    });
    const created = fake.calls.create;
    expect(
      await openComputerSession(
        db,
        { provider: fake.provider, metering: noMetering },
        { ...(await member('a')), clientId: 'agent-client' },
      ),
    ).toHaveProperty('sessionId');
    expect(fake.calls.create).toBe(created + 1);
    // A provider failure keeps the computer recorded, so a retry kills it.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = client({
      ...fake.provider,
      kill: async () => {
        throw new Error('provider down');
      },
    });
    expect((await failing('POST', '/computer/reset', { cookie: b })).status).toBe(503);
    expect((await (await request('GET', '/computer', { cookie: b })).json()).computer).not.toBeNull();
  });

  it('report the computer, busy only while an agent holds one of its forks', async () => {
    const a = await identity('a');
    const request = client();
    expect(await (await request('GET', '/computer', { cookie: a })).json()).toMatchObject({ computer: null });
    await openComputerSession(
      db,
      { provider: fake.provider, metering: noMetering },
      { ...(await member('a')), clientId: 'agent-client' },
    );
    expect((await (await request('GET', '/computer', { cookie: a })).json()).computer).toMatchObject({
      status: 'ready',
      busy: true,
    });
    await db.update(schema.computerSessions).set({ lastCallAt: new Date(Date.now() - 61_000) });
    expect((await (await request('GET', '/computer', { cookie: a })).json()).computer.busy).toBe(false);
  });

  it("keep each page load's live view watch through the heartbeat, per user, and validate what it reports", async () => {
    const request = client();
    const a = await identity('a');
    const b = await identity('b');
    const page = randomUUID();
    const beat = async (user: string, leases: unknown) => {
      const response = await request('POST', '/heartbeat', { cookie: user, body: { leases } });
      return { status: response.status, json: await response.json() };
    };
    const lease = (state: string, id: string = page) => ({ kind: 'live-view', id, state });
    for (const leases of [
      [],
      [{ ...lease('visible'), kind: 'other' }],
      [lease('visible', 'not-a-uuid')],
      [lease('focused')],
      [{ ...lease('visible'), extra: true }],
      Array.from({ length: 9 }, () => lease('visible', randomUUID())),
    ])
      expect((await beat(a, leases)).status, JSON.stringify(leases).slice(0, 80)).toBe(400);
    expect((await request('POST', '/heartbeat', { cookie: a, body: 'not json' })).status).toBe(400);
    // No computer yet: watching creates it.
    expect(await beat(a, [lease('visible')])).toEqual({
      status: 200,
      json: {
        leases: [
          {
            kind: 'live-view',
            id: page,
            status: { computer: 'running', watching: true, takeover: null, agentWaiting: null },
          },
        ],
      },
    });
    expect(fake.calls.create).toBe(1);
    await openComputerSession(
      db,
      { provider: fake.provider, metering: noMetering },
      { ...(await member('a')), clientId: 'agent-client' },
    );
    expect((await beat(a, [lease('visible')])).json.leases[0].status).toMatchObject({
      computer: 'running',
      watching: true,
    });
    // Another user's heartbeat on the same lease ID reaches only their own (missing) computer.
    expect((await beat(b, [lease('released')])).json.leases[0].status).toMatchObject({
      computer: 'none',
      watching: false,
    });
    expect((await beat(a, [lease('hidden')])).json.leases[0].status.watching).toBe(true);
    expect((await beat(a, [lease('released')])).json.leases[0].status.watching).toBe(false);
  });

  it('take control for one page load and hand back, per user, refusing while metering refuses', async () => {
    let refusal: MeteringRefusal | null = null;
    const metering = { ...noMetering, refusal: async () => refusal };
    const request = client(fake.provider, { hooks: { metering, operatorAdmin: noOperatorAdmin } });
    const a = await identity('a');
    const b = await identity('b');
    const page = randomUUID();
    const call = async (user: string, path: string, body: unknown) => {
      const response = await request('POST', path, { cookie: user, body });
      return { status: response.status, json: await response.json() };
    };
    for (const path of ['/computer/takeover', '/computer/hand-back'])
      for (const body of [{}, { lease: 'not-a-uuid' }, { lease: page, extra: true }, 'not json'])
        expect((await call(a, path, body)).status, `${path} ${JSON.stringify(body)}`).toBe(400);
    // With no agent working, a takeover creates the computer.
    const taken = await call(a, '/computer/takeover', { lease: page });
    expect(taken).toMatchObject({
      status: 200,
      json: { computer: 'running', watching: true, takeover: { mine: true, since: expect.any(String) } },
    });
    expect(fake.calls.create).toBe(1);
    // Another user can neither hand back nor see it; the same lease ID only reaches their own computer.
    expect((await call(b, '/computer/hand-back', { lease: page })).json).toMatchObject({
      computer: 'none',
      takeover: null,
    });
    // A second page load of the same user moves the takeover to itself.
    const other = randomUUID();
    expect((await call(a, '/computer/takeover', { lease: other })).json.takeover).toEqual({
      mine: true,
      since: taken.json.takeover.since,
    });
    expect((await call(a, '/computer/hand-back', { lease: page })).json.takeover).toEqual({
      mine: false,
      since: taken.json.takeover.since,
    });
    const handed = await call(a, '/computer/hand-back', { lease: other });
    expect(handed).toMatchObject({ status: 200, json: { takeover: null, watching: true } });
    expect((await call(a, '/computer/hand-back', { lease: other })).status).toBe(200);
    // A metering refusal (a used-up allowance) refuses the takeover with when it lifts.
    refusal = { message: 'Used up.', resetsAt: new Date('2026-11-01T00:00:00Z') };
    expect(await call(a, '/computer/takeover', { lease: page })).toEqual({
      status: 403,
      json: { error: 'allowance_exhausted', message: 'Used up.', resetsAt: '2026-11-01T00:00:00.000Z' },
    });
  });

  it("set the computer's clipboard only for the page load in control, per user, refusing oversized text", async () => {
    const request = client();
    const a = await identity('a');
    const b = await identity('b');
    const page = randomUUID();
    const paste = async (user: string, body: unknown) => {
      const response = await request('POST', '/computer/clipboard', { cookie: user, body });
      return { status: response.status, json: await response.json() };
    };
    for (const body of [
      {},
      { lease: page },
      { lease: 'not-a-uuid', text: 'x' },
      { lease: page, text: 1 },
      { lease: page, text: 'x', extra: true },
      'not json',
    ])
      expect((await paste(a, body)).status, JSON.stringify(body)).toBe(400);
    // No computer, or no takeover yet.
    expect(await paste(a, { lease: page, text: 'x' })).toEqual({ status: 409, json: { error: 'not_in_control' } });
    await request('POST', '/computer/takeover', { cookie: a, body: { lease: page } });
    const text = 'café “quoted” 日本語 🎉';
    expect(await paste(a, { lease: page, text })).toEqual({ status: 200, json: {} });
    const sandbox = () => [...fake.sandboxes.values()][0]!;
    expect(sandbox().clipboard).toBe(text);
    // Another page load of the same user only watches; another user has no takeover, whatever lease they send.
    expect((await paste(a, { lease: randomUUID(), text: 'other page' })).status).toBe(409);
    expect((await paste(b, { lease: page, text: 'other user' })).status).toBe(409);
    expect(sandbox().clipboard).toBe(text);
    // 1 MiB of UTF-8: two-byte characters count twice. A body past the upload limit is refused before it is read.
    expect((await paste(a, { lease: page, text: 'é'.repeat(512 * 1024) })).status).toBe(200);
    expect(await paste(a, { lease: page, text: `${'é'.repeat(512 * 1024)}x` })).toEqual({
      status: 413,
      json: { error: 'too_large' },
    });
    expect(await paste(a, { lease: page, text: 'x'.repeat(4_000_001) })).toEqual({
      status: 413,
      json: { error: 'too_large' },
    });
    expect(sandbox().clipboard).toHaveLength(512 * 1024);
    // A computer that cannot take it is a 503; after the hand-back, the page is no longer in control.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.failClipboard();
    expect(await paste(a, { lease: page, text })).toEqual({ status: 503, json: { error: 'service_unavailable' } });
    fake.failClipboard(false);
    await request('POST', '/computer/hand-back', { cookie: a, body: { lease: page } });
    expect((await paste(a, { lease: page, text })).status).toBe(409);
  });

  it('answer a takeover with starting while another request creates the computer, and 503 when it is unreachable', async () => {
    const a = await identity('a');
    const b = await identity('b');
    const page = randomUUID();
    await db
      .insert(schema.computers)
      .values({ membershipId: (await member('a')).membershipId, publicId: 'computer_creating' });
    const starting = await client()('POST', '/computer/takeover', { cookie: a, body: { lease: page } });
    expect(starting.status).toBe(409);
    expect(await starting.json()).toMatchObject({ error: 'starting' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unreachable = client({
      ...fake.provider,
      connect: async () => {
        throw new Error('provider down');
      },
    });
    expect((await unreachable('POST', '/computer/takeover', { cookie: b, body: { lease: page } })).status).toBe(503);
    // The takeover is given back rather than held on a computer nobody can use.
    const status = await (await client()('POST', '/computer/hand-back', { cookie: b, body: { lease: page } })).json();
    expect(status.takeover).toBeNull();
  });

  it('turn unexpected failures into a generic 503 and log only the error class', async () => {
    const a = await identity('a');
    await openComputerSession(
      db,
      { provider: fake.provider, metering: noMetering },
      { ...(await member('a')), clientId: 'agent-client' },
    );
    const failing: ComputerProvider = {
      ...fake.provider,
      kill: async () => {
        throw new Error('postgres://user:secret@db/sandbox-token');
      },
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await client(failing)('DELETE', '/computer', { cookie: a });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
    expect(logged).toHaveBeenCalled();
    expect(logged.mock.calls.flat().join(' ')).not.toContain('secret');
  });
  it("show and change only the current membership's sync data and setup, and a browser's own membership's", async () => {
    const request = client();
    const a = await identity('a');
    await identity('b');
    // A second, newer membership in another organization: not the one the web app acts in.
    const owner = { id: 'b', name: 'b', email: 'b@example.test' };
    const team = await membership(
      db,
      'a',
      (await db.transaction(tx => createOrganization(tx, { name: 'Team', owner })))!,
    );
    await saveCapture(db, team, siteBundle([cookie({ domain: 'notion.so' })], ['notion.so']));
    await adoptSyncSettings(db, team, { sites: ['notion.so'], excludedDomains: [], paused: true }, '127.0.0.1');
    await recordSetupStep(db, team, 'setUp');
    expect(await (await request('GET', '/sync', { cookie: a })).json()).toMatchObject({
      settings: null,
      disconnected: false,
    });
    expect(await (await request('GET', '/setup', { cookie: a })).json()).toMatchObject({
      items: { browserSync: false, computer: false },
    });
    // The extension's upload lands in its browser's membership, the current one when it connected.
    const capture = siteBundle([cookie({ domain: 'github.com' })], ['github.com']);
    expect((await request('POST', '/captures', { token: await browser(a), body: { capture } })).status).toBe(200);
    expect(await (await request('GET', '/setup', { cookie: a })).json()).toMatchObject({
      items: { browserSync: true },
      sync: { mode: 'sites', sites: ['github.com'] },
    });
    // Delete everything leaves the other membership's capture, settings, and setup.
    expect((await request('DELETE', '/computer', { cookie: a })).status).toBe(200);
    expect(await captureView(db, team)).toMatchObject({ cookieCount: 1 });
    expect((await syncView(db, team)).settings).toMatchObject({ sites: ['notion.so'] });
    expect((await setupView(db, team)).items.computer).toBe(true);
  });
});
