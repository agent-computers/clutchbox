import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { databaseSchema } from '@clutchbox/server/database-schema';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../../server/src/auth';
import { connectBrowser } from '../../server/src/browser-fixtures';
import { ensureExtensionClient } from '../../server/src/browsers';
import type { ServerConfig } from '../../server/src/config';
import type { Database } from '../../server/src/database';
import { fakeComputerProvider } from '../../server/src/fake-computer-provider';
import { defaultServerHooks, type Limits, noLimits } from '../../server/src/hooks';
import { membership, switchTo } from '../../server/src/member-fixtures';
import { createOrganization } from '../../server/src/organizations';
import * as schema from '../../server/src/schema';
import { createApi } from './index';

// Connect: an organization's app sends a person through sign-in, joining, the extension, and consent, and gets back
// their member ID and its own ID for them. Driven through Better Auth's endpoints and our API, as the pages drive them.
const origin = 'http://localhost:3099';
const callback = 'https://app.example.test/callback';
const extension = `chrome-extension://${'b'.repeat(32)}`;
const config: ServerConfig = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/synthetic',
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'synthetic-only',
};
let template: PGlite;
let pg: PGlite;
let db: Database;
let auth: ReturnType<typeof createAuth>;
let appCo: string;
let ownerCookie: string;
beforeAll(async () => {
  template = new PGlite();
  const templateDb = drizzle(template, { schema: databaseSchema });
  await migrate(templateDb, { migrationsFolder: fileURLToPath(new URL('../../server/migrations', import.meta.url)) });
  await ensureExtensionClient(templateDb as unknown as Database, extension);
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  db = drizzle(pg, { schema: databaseSchema }) as unknown as Database;
  auth = createAuth(db, config);
  await auth.$context;
  vi.stubEnv('CAPTURE_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('EXTENSION_ORIGINS', extension);
  ownerCookie = await signedIn('dev');
  appCo = (await db.transaction(tx =>
    createOrganization(tx, { name: 'App Co', owner: { id: 'dev', name: 'Dev', email: 'dev@example.test' } }),
  ))!;
});
afterEach(async () => {
  limits = noLimits;
  vi.unstubAllEnvs();
  await pg.close();
});

async function signedIn(id: string) {
  await db.insert(schema.user).values({ id, name: `Fixture ${id}`, email: `${id}@example.test`, emailVerified: true });
  const token = randomBytes(32).toString('base64url');
  await db
    .insert(schema.session)
    .values({ id: randomUUID(), userId: id, token, expiresAt: new Date(Date.now() + 3600_000) });
  const signature = createHmac('sha256', config.BETTER_AUTH_SECRET).update(token).digest('base64');
  return `${(await auth.$context).authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
}
// The deployment's limits, none unless a test sets them.
let limits: Limits = noLimits;
const api = () =>
  createApi({ db, auth, origin, computers: fakeComputerProvider().provider, hooks: { ...defaultServerHooks, limits } });
function request(cookie: string, method: string, path: string, body?: unknown, from = origin) {
  return api().request(`${origin}/api/v1${path}`, {
    method,
    headers: { cookie, origin: from, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function authRequest(
  path: string,
  {
    cookie,
    body,
    headers = {},
  }: { cookie?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {},
) {
  const form = path === '/oauth2/token';
  return auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        origin,
        ...headers,
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
      },
      ...(body
        ? { body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body) }
        : {}),
    }),
  );
}
type App = { id: string; secret: string };
async function registerApp(name = 'Fixture app', cookie = ownerCookie): Promise<App> {
  const response = await request(cookie, 'POST', '/organization/connect-apps', { name, redirectUris: [callback] });
  expect(response.status).toBe(201);
  return (await response.json()).app;
}
// The app's authorize request; answers the redirect and the PKCE verifier.
async function authorize(cookie: string, app: App, extra: Record<string, string> = {}) {
  const verifier = randomBytes(48).toString('base64url');
  const query = new URLSearchParams({
    client_id: app.id,
    redirect_uri: callback,
    response_type: 'code',
    scope: 'openid connect',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: randomUUID(),
    ...extra,
  });
  const response = await authRequest(`/oauth2/authorize?${query}`, { cookie });
  return { location: new URL(response.headers.get('location') ?? '/', origin), verifier, state: query.get('state')! };
}
// What /connect's Continue does: switch to the app's organization, then resume the authorize request.
async function proceed(cookie: string, oauthQuery: string) {
  expect((await request(cookie, 'POST', '/connect/join', { oauthQuery })).status).toBe(200);
  const response = await authRequest('/oauth2/continue', {
    cookie,
    body: { postLogin: true, oauth_query: oauthQuery },
  });
  return new URL((await response.json()).url);
}
async function consent(cookie: string, consentAt: URL) {
  expect(consentAt.pathname).toBe('/consent');
  const response = await authRequest('/oauth2/consent', {
    cookie,
    body: { accept: true, oauth_query: consentAt.search.slice(1) },
  });
  return new URL((await response.json()).url);
}
const basic = (app: App) => ({ authorization: `Basic ${Buffer.from(`${app.id}:${app.secret}`).toString('base64')}` });
function exchange(app: App, code: string, verifier: string) {
  return authRequest('/oauth2/token', {
    headers: basic(app),
    body: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: callback },
  });
}
const status = async (cookie: string, oauthQuery: string) =>
  (await request(cookie, 'POST', '/connect/status', { oauthQuery })).json();

describe('Connect', () => {
  it('sends a new person through joining and the extension, and gives the app their member ID and its own ID', async () => {
    const app = await registerApp();
    const cookie = await signedIn('person');
    const { location, verifier, state } = await authorize(cookie, app, { external_user_id: 'user-42' });
    expect(location.pathname).toBe('/connect');
    const oauthQuery = location.search.slice(1);
    expect(await status(cookie, oauthQuery)).toEqual({
      app: { id: app.id, name: 'Fixture app' },
      organization: 'App Co',
      member: false,
      browser: false,
    });
    expect((await request(cookie, 'POST', '/connect/join', { oauthQuery })).status).toBe(200);
    expect(await status(cookie, oauthQuery)).toMatchObject({ member: true, browser: false });
    // The extension connects while the person acts in the app's organization, so its browser syncs there.
    await connectBrowser(auth, cookie, { extensionOrigin: extension });
    expect(await status(cookie, oauthQuery)).toMatchObject({ member: true, browser: true });
    const redirect = await consent(cookie, await proceed(cookie, oauthQuery));
    expect(redirect.origin + redirect.pathname).toBe(callback);
    expect(redirect.searchParams.get('state')).toBe(state);
    const token = await exchange(app, redirect.searchParams.get('code')!, verifier);
    expect(token.status).toBe(200);
    const body = await token.json();
    const [joined] = await db
      .select({ publicId: schema.memberships.publicId, role: schema.memberships.role })
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, 'person'));
    expect(joined!.role).toBe('member');
    expect(body).toMatchObject({ member: joined!.publicId, external_user_id: 'user-42' });
    // The app's server finds them with an organization API key.
    const { key } = await auth.api.createApiKey({ body: { name: 'K', organizationId: appCo, userId: 'dev' } });
    const listed = await api().request(`${origin}/api/v1/connections`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect((await listed.json()).connections).toEqual([
      { app: app.id, member: joined!.publicId, externalUserId: 'user-42', connectedAt: expect.any(String) },
    ]);
    // It is not an agent: the Agents page leaves it out.
    expect((await (await request(cookie, 'GET', '/mcp/grants')).json()).grants).toEqual([]);
  });

  it("refuses joining, and the organization's API keys, as the deployment's limits say", async () => {
    const app = await registerApp();
    const { key } = await auth.api.createApiKey({ body: { name: 'K', organizationId: appCo, userId: 'dev' } });
    const connections = () =>
      api().request(`${origin}/api/v1/connections`, { headers: { authorization: `Bearer ${key}` } });
    const cookie = await signedIn('person');
    const oauthQuery = (await authorize(cookie, app)).location.search.slice(1);
    const join = () => request(cookie, 'POST', '/connect/join', { oauthQuery });
    // An organization the deployment refuses: no joining, and its keys are refused before they reach a route.
    limits = { ...noLimits, apiRefusal: async (_, id) => (id === appCo ? 'Choose a plan.' : null) };
    for (const refused of [await join(), await connections()]) {
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: 'organization_unavailable', message: 'Choose a plan.' });
    }
    expect(await db.select().from(schema.memberships).where(eq(schema.memberships.userId, 'person'))).toEqual([]);
    // One that is full: no new member, though a member already in it may still go through Connect.
    limits = { ...noLimits, members: async () => ({ limit: 1, message: 'Full.' }) };
    expect((await connections()).status).toBe(200);
    const full = await join();
    expect(full.status).toBe(403);
    expect(await full.json()).toEqual({ error: 'member_limit', message: 'Full.' });
    limits = noLimits;
    expect((await join()).status).toBe(200);
    limits = { ...noLimits, members: async () => ({ limit: 1, message: 'Full.' }) };
    expect((await join()).status).toBe(200);
  });

  it('lets a returning member skip the extension steps and consent, and updates the external ID', async () => {
    const app = await registerApp();
    const cookie = await signedIn('person');
    const first = await authorize(cookie, app, { external_user_id: 'old' });
    await request(cookie, 'POST', '/connect/join', { oauthQuery: first.location.search.slice(1) });
    await connectBrowser(auth, cookie, { extensionOrigin: extension });
    const firstRedirect = await consent(cookie, await proceed(cookie, first.location.search.slice(1)));
    expect((await exchange(app, firstRedirect.searchParams.get('code')!, first.verifier)).status).toBe(200);

    const again = await authorize(cookie, app, { external_user_id: 'new' });
    expect(await status(cookie, again.location.search.slice(1))).toMatchObject({ member: true, browser: true });
    // Consent is remembered, so continuing goes straight back to the app.
    const redirect = await proceed(cookie, again.location.search.slice(1));
    expect(redirect.origin + redirect.pathname).toBe(callback);
    expect(await (await exchange(app, redirect.searchParams.get('code')!, again.verifier)).json()).toMatchObject({
      external_user_id: 'new',
    });
    expect(await db.select({ external: schema.connections.externalUserId }).from(schema.connections)).toEqual([
      { external: 'new' },
    ]);
  });

  it('refuses a substituted app, redirect, secret, verifier, or replayed code, and a tampered request', async () => {
    const app = await registerApp();
    const other = await registerApp('Other app');
    const cookie = await signedIn('person');
    // A redirect the app did not register is never redirected to.
    const bad = await authorize(cookie, app, { redirect_uri: 'https://evil.test/callback' });
    expect(bad.location.origin).toBe(origin);
    expect(bad.location.searchParams.get('error')).toBe('invalid_redirect');
    const { location, verifier } = await authorize(cookie, app);
    const oauthQuery = location.search.slice(1);
    // Our pages act only on a request the server signed.
    const tampered = oauthQuery.replace(app.id, other.id);
    expect((await request(cookie, 'POST', '/connect/join', { oauthQuery: tampered })).status).toBe(400);
    expect((await request(cookie, 'POST', '/connect/status', { oauthQuery: tampered })).status).toBe(400);
    expect((await request(cookie, 'POST', '/connect/join', { oauthQuery }, 'https://evil.test')).status).toBe(403);
    const first = await consent(cookie, await proceed(cookie, oauthQuery));
    // Each refused exchange uses up its code, so each check gets a fresh one (consent is remembered now).
    const fresh = async () => {
      const next = await authorize(cookie, app);
      const redirect = await proceed(cookie, next.location.search.slice(1));
      return { code: redirect.searchParams.get('code')!, verifier: next.verifier };
    };
    const substituted = await exchange(other, first.searchParams.get('code')!, verifier);
    expect([substituted.status, (await substituted.json()).error]).toEqual([400, 'invalid_grant']);
    const wrongSecret = await fresh();
    expect((await exchange({ ...app, secret: 'wrong' }, wrongSecret.code, wrongSecret.verifier)).status).toBe(401);
    const wrongVerifier = await fresh();
    expect((await exchange(app, wrongVerifier.code, randomBytes(48).toString('base64url'))).status).toBe(400);
    const replayed = await fresh();
    expect((await exchange(app, replayed.code, replayed.verifier)).status).toBe(200);
    expect((await exchange(app, replayed.code, replayed.verifier)).status).toBe(400);
  });

  it("fails the exchange when the grant isn't for the app's organization", async () => {
    const app = await registerApp();
    const cookie = await signedIn('person');
    await db.transaction(tx =>
      createOrganization(tx, {
        name: 'Elsewhere',
        owner: { id: 'person', name: 'P', email: 'person@example.test' },
        personal: true,
      }),
    );
    const { location, verifier } = await authorize(cookie, app);
    const oauthQuery = location.search.slice(1);
    const consentAt = await proceed(cookie, oauthQuery);
    // Switched away before consenting (the consent page refuses this; the exchange is the backstop).
    const [elsewhere] = await db
      .select({ publicId: schema.organizations.publicId })
      .from(schema.organizations)
      .where(eq(schema.organizations.name, 'Elsewhere'));
    await switchTo(db, 'person', elsewhere!.publicId);
    const redirect = await consent(cookie, consentAt);
    expect((await exchange(app, redirect.searchParams.get('code')!, verifier)).status).toBe(400);
    expect(await db.select().from(schema.connections)).toEqual([]);
  });

  it('ends the connection when the member is removed or the app deleted', async () => {
    const app = await registerApp();
    const later = await registerApp('Later');
    for (const [person, target] of [
      ['a', app],
      ['b', app],
      ['c', later],
    ] as const) {
      const cookie = await signedIn(person);
      const { location, verifier } = await authorize(cookie, target);
      const redirect = await consent(cookie, await proceed(cookie, location.search.slice(1)));
      expect((await exchange(target, redirect.searchParams.get('code')!, verifier)).status).toBe(200);
    }
    const count = async () => (await db.select().from(schema.connections)).length;
    expect(await count()).toBe(3);
    const [b] = await db
      .select({ publicId: schema.memberships.publicId })
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, 'b'));
    expect((await request(ownerCookie, 'DELETE', `/organization/members/${b!.publicId}`)).status).toBe(200);
    expect(await count()).toBe(2);
    expect((await request(ownerCookie, 'DELETE', `/organization/connect-apps/${app.id}`)).status).toBe(200);
    expect(await count()).toBe(1);
    // The deleted app can no longer start a sign-in.
    const cookie = await signedIn('d');
    const { location } = await authorize(cookie, app);
    expect(location.pathname).not.toBe('/connect');
  });

  it('are registered, listed, and deleted by owners and admins only', async () => {
    const plain = await signedIn('plain');
    await membership(db, 'plain', appCo);
    const outsider = await signedIn('outsider');
    await db.transaction(tx =>
      createOrganization(tx, { name: 'Other', owner: { id: 'outsider', name: 'O', email: 'outsider@example.test' } }),
    );
    const body = { name: 'App', redirectUris: [callback] };
    expect((await request('', 'POST', '/organization/connect-apps', body)).status).toBe(401);
    expect((await request(ownerCookie, 'POST', '/organization/connect-apps', body, 'https://evil.test')).status).toBe(
      403,
    );
    expect((await request(plain, 'POST', '/organization/connect-apps', body)).status).toBe(403);
    expect((await request(plain, 'GET', '/organization/connect-apps')).status).toBe(403);
    for (const bad of [{}, { name: 'App', redirectUris: [] }, { name: '', redirectUris: [callback] }])
      expect((await request(ownerCookie, 'POST', '/organization/connect-apps', bad)).status).toBe(400);
    for (const uri of ['http://app.example.test/cb', 'https://app.example.test/cb#x', 'not a url'])
      expect(
        await (
          await request(ownerCookie, 'POST', '/organization/connect-apps', { name: 'A', redirectUris: [uri] })
        ).json(),
        uri,
      ).toEqual({ error: 'invalid_redirect_uri' });
    const app = await registerApp('Listed');
    const listed = (await (await request(ownerCookie, 'GET', '/organization/connect-apps')).json()).apps;
    expect(listed[0]).toEqual({
      id: app.id,
      name: 'Listed',
      redirectUris: [callback],
      createdAt: expect.any(String),
      connections: 0,
    });
    expect(JSON.stringify(listed)).not.toContain(app.secret);
    expect((await request(outsider, 'DELETE', `/organization/connect-apps/${app.id}`)).status).toBe(404);
    expect((await request(plain, 'DELETE', `/organization/connect-apps/${app.id}`)).status).toBe(403);
    expect((await request(ownerCookie, 'DELETE', '/organization/connect-apps/nope')).status).toBe(400);
  });
});
