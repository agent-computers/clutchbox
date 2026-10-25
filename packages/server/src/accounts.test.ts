import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../../api/src/index';
import { createAuth, getPrincipal } from './auth';
import { readConfig, type ServerConfig } from './config';
import { assertDatabaseEnvironment, type Database } from './database';
import { fakeComputerProvider } from './fake-computer-provider';
import * as schema from './schema';

const origin = 'http://localhost:3000';
const config: ServerConfig = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/synthetic',
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'synthetic-only',
};
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
let pg: PGlite;
let db: Database;
let auth: ReturnType<typeof createAuth>;
let api: ReturnType<typeof createApi>;
async function identity(id: string, verified = true, expiresAt = new Date(Date.now() + 3600_000)) {
  await db
    .insert(schema.user)
    .values({ id, name: `Fixture ${id}`, email: `${id}@example.test`, emailVerified: verified });
  const token = randomBytes(32).toString('base64url');
  await db.insert(schema.session).values({ id: crypto.randomUUID(), userId: id, token, expiresAt });
  const signature = createHmac('sha256', config.BETTER_AUTH_SECRET).update(token).digest('base64');
  const context = await auth.$context;
  return { token, cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}` };
}
function request(path: string, cookie?: string, method = 'GET', requestOrigin = origin) {
  const headers = new Headers({ origin: requestOrigin });
  if (cookie) headers.set('cookie', cookie);
  return api.request(`${origin}/api/v1${path}`, { method, headers });
}
// Migrate once per file; each test gets its own clone, which is much cheaper than a fresh database.
// Migrate once per file and give each test a clone, which is much faster than a new database.
let template: PGlite;
beforeAll(async () => {
  template = new PGlite();
  await migrate(drizzle(template, { schema }), { migrationsFolder });
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  const embedded = drizzle(pg, { schema });
  // Same Postgres SQL/schema; the production driver uses a network pool.
  db = embedded as unknown as Database;
  await db.insert(schema.installation).values({ dataClass: 'nonproduction' });
  auth = createAuth(db, config);
  await auth.$context;
  api = createApi({ db, auth, origin, computers: fakeComputerProvider().provider });
});
afterEach(async () => {
  await pg.close();
});

describe('account boundary', () => {
  it('applies the checked-in migration repeatedly without changing existing accounts', async () => {
    await identity('first');
    const before = await db.select().from(schema.user);
    await migrate(drizzle(pg, { schema }), { migrationsFolder });
    expect(await db.select().from(schema.user)).toEqual(before);
  });
  it('renews an active session cookie through API calls', async () => {
    // Older than updateAge (1 day) within the 7-day lifetime.
    const first = await identity('first', true, new Date(Date.now() + 5 * 86_400_000));
    const response = await request('/me', first.cookie);
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find(value => value.startsWith(first.cookie.split('=')[0]!));
    expect(cookie).toMatch(/Max-Age=604800/);
    const [stored] = await db.select().from(schema.session).where(eq(schema.session.token, first.token));
    expect(stored!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const fresh = await identity('second', true, new Date(Date.now() + 7 * 86_400_000));
    expect((await request('/me', fresh.cookie)).headers.getSetCookie()).toEqual([]);
  });
  it('authenticates signed database sessions and ignores forged identity headers', async () => {
    const first = await identity('first');
    expect((await request('/me')).status).toBe(401);
    const forged = await api.request(`${origin}/api/v1/me`, {
      headers: { 'x-user-id': 'first', authorization: 'Bearer forged' },
    });
    expect(forged.status).toBe(401);
    const valid = await request('/me', first.cookie);
    expect(valid.status).toBe(200);
    expect((await valid.json()).user.id).toBe('first');
    expect(valid.headers.get('cache-control')).toContain('no-store');
    const changed = first.cookie.replace(/.$/, 'x');
    expect((await request('/me', changed)).status).toBe(401);
  });
  it('immediately rejects expired, revoked and unverified sessions', async () => {
    const expired = await identity('expired', true, new Date(Date.now() - 1000));
    const unverified = await identity('unverified', false);
    const revoked = await identity('revoked');
    expect((await request('/me', expired.cookie)).status).toBe(401);
    expect((await request('/me', unverified.cookie)).status).toBe(401);
    expect((await request('/me', revoked.cookie)).status).toBe(200);
    await db.delete(schema.session).where(eq(schema.session.token, revoked.token));
    expect((await request('/me', revoked.cookie)).status).toBe(401);
  });
  it('sign-out through Better Auth invalidates a copied cookie and survives app recreation', async () => {
    const first = await identity('first');
    const beforeRestart = await getPrincipal(auth, new Headers({ cookie: first.cookie }));
    const restarted = createAuth(db, config);
    expect(await getPrincipal(restarted, new Headers({ cookie: first.cookie }))).toEqual(beforeRestart);
    const response = await auth.handler(
      new Request(`${origin}/api/auth/sign-out`, {
        method: 'POST',
        headers: { cookie: first.cookie, origin, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(200);
    expect(await getPrincipal(restarted, new Headers({ cookie: first.cookie }))).toBeNull();
  });
  it('exposes only Google signup and rejects external callback destinations', async () => {
    const attempt = (provider: string, callbackURL: string) =>
      auth.handler(
        new Request(`${origin}/api/auth/sign-in/social`, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ provider, callbackURL }),
        }),
      );
    expect((await attempt('github', '/app')).status).toBeGreaterThanOrEqual(400);
    expect((await attempt('google', 'https://evil.test')).status).toBeGreaterThanOrEqual(400);
    const google = await attempt('google', '/app');
    expect(google.status).toBe(200);
    const data = await google.json();
    expect(new URL(data.url).hostname).toBe('accounts.google.com');
    expect(new URL(data.url).searchParams.get('scope')).not.toContain('gmail');
  });
  it('sends OAuth errors without a per-flow destination to sign-in', async () => {
    const lostState = await auth.handler(new Request(`${origin}/api/auth/callback/google?code=synthetic`));
    expect(lostState.status).toBe(302);
    expect(lostState.headers.get('location')).toBe(`${origin}/sign-in?error=state_not_found`);
    const forgedState = await auth.handler(
      new Request(`${origin}/api/auth/callback/google?code=synthetic&state=forged`),
    );
    expect(new URL(forgedState.headers.get('location')!).pathname).toBe('/sign-in');
    const errorPage = await auth.handler(new Request(`${origin}/api/auth/error?error=access_denied`));
    expect(errorPage.headers.get('location')).toBe(`${origin}/sign-in?error=access_denied`);
  });
  it('fails closed when preview points to a production database', async () => {
    await expect(assertDatabaseEnvironment(db, 'preview')).resolves.toBeUndefined();
    await expect(assertDatabaseEnvironment(db, 'production')).rejects.toThrow('Database environment mismatch');
    await db.update(schema.installation).set({ dataClass: 'production' });
    await expect(assertDatabaseEnvironment(db, 'preview')).rejects.toThrow('Database environment mismatch');
  });
  it('runs without operator admin under the default hooks: no admin or dashboard routes, no activity tracking', async () => {
    const first = await identity('first');
    for (const path of ['/admin/ban-user', '/admin/list-users', '/dash/ban-user']) {
      const response = await auth.handler(
        new Request(`${origin}/api/auth${path}`, {
          method: 'POST',
          headers: { origin, cookie: first.cookie, 'content-type': 'application/json' },
          body: '{}',
        }),
      );
      expect(response.status, path).toBe(404);
    }
    expect((await request('/me', first.cookie)).status).toBe(200);
    expect((await db.select({ lastActiveAt: schema.user.lastActiveAt }).from(schema.user))[0]!.lastActiveAt).toBeNull();
  });
});
describe('time zone', () => {
  it('stores the browser time zone per user, only valid zones, and only from the web origin', async () => {
    const first = await identity('first');
    const second = await identity('second');
    const put = (body: unknown, cookie?: string, requestOrigin = origin) =>
      api.request(`${origin}/api/v1/time-zone`, {
        method: 'PUT',
        headers: { ...(cookie ? { cookie } : {}), origin: requestOrigin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const stored = async (userId: string) =>
      (await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, userId)))[0];
    expect((await put({ timeZone: 'America/Los_Angeles' })).status).toBe(401);
    expect((await put({ timeZone: 'America/Los_Angeles' }, first.cookie, 'https://evil.test')).status).toBe(403);
    for (const timeZone of ['Mars/Olympus_Mons', '../../etc/passwd', 'America/Los Angeles', '+05:30', '', 7])
      expect((await put({ timeZone }, first.cookie)).status, `${timeZone}`).toBe(400);
    expect((await put({ timeZone: 'UTC', userId: 'second' }, first.cookie)).status).toBe(400);
    const response = await put({ timeZone: 'America/Los_Angeles' }, first.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ timeZone: 'America/Los_Angeles' });
    const before = await stored('first');
    expect(before?.timeZone).toBe('America/Los_Angeles');
    expect(await stored('second')).toBeUndefined();
    // The same zone again leaves the row alone; a new one replaces it.
    await put({ timeZone: 'America/Los_Angeles' }, first.cookie);
    expect((await stored('first'))?.updatedAt).toEqual(before?.updatedAt);
    expect((await put({ timeZone: 'Asia/Calcutta' }, first.cookie)).status).toBe(200);
    expect((await stored('first'))?.timeZone).toBe('Asia/Calcutta');
    expect((await put({ timeZone: 'Europe/London' }, second.cookie)).status).toBe(200);
    expect((await stored('first'))?.timeZone).toBe('Asia/Calcutta');
  });
});
describe('deployment configuration', () => {
  it('rejects missing secrets, untrusted origins, environment mismatches and deployed test mode without echoing secrets', () => {
    expect(() => readConfig({})).toThrow('Server configuration is incomplete');
    expect(() => readConfig({ ...config, NODE_ENV: 'test' })).not.toThrow();
    expect(() => readConfig({ ...config, NODE_ENV: 'test', VERCEL: '1' })).toThrow('Test configuration');
    expect(() => readConfig({ ...config, APP_ENV: 'preview', VERCEL_ENV: 'production' })).toThrow();
    expect(() => readConfig({ ...config, APP_ENV: 'production' })).toThrow('HTTPS');
    expect(() => readConfig({ ...config, BETTER_AUTH_URL: 'https://user:secret@example.test' })).toThrow(
      'must be an origin',
    );
  });
});
