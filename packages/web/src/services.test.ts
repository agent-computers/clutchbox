import { createHmac, randomBytes } from 'node:crypto';
import type { Database } from '@agent-computers/server/database';
import { defaultServerHooks, noMetering } from '@agent-computers/server/hooks';
import { migrationsFolder } from '@agent-computers/server/migrator';
import * as schema from '@agent-computers/server/schema';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRoute } from './routes/api';
import { authRoute } from './routes/auth';
import { createServices } from './services';

// The product's services, built from the no-op defaults, on a PGlite database instead of the pool.
let db: Database;
vi.mock('@agent-computers/server/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@agent-computers/server/database')>()),
  createDatabase: () => ({ db, pool: undefined }),
}));

const origin = 'http://localhost:3000';
const extension = `chrome-extension://${'a'.repeat(32)}`;
const secret = randomBytes(32).toString('base64url');
let pg: PGlite;
let template: PGlite;
beforeAll(async () => {
  template = new PGlite();
  await migrate(drizzle(template, { schema }), { migrationsFolder });
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  db = drizzle(pg, { schema }) as unknown as Database;
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
  vi.unstubAllEnvs();
  await pg.close();
});
const installed = () => db.insert(schema.installation).values({ dataClass: 'nonproduction' });

describe('services', () => {
  it('build from the open defaults: no metering, no operator admin, and no deployment routes', async () => {
    await installed();
    const { hooks, auth, api } = await createServices(defaultServerHooks)();
    expect(hooks.metering).toBe(noMetering);
    expect(auth.options.plugins.map(plugin => plugin.id)).not.toContain('admin');
    await db.insert(schema.user).values({ id: 'a', name: 'a', email: 'a@example.test', emailVerified: true });
    const token = randomBytes(32).toString('base64url');
    await db
      .insert(schema.session)
      .values({ id: crypto.randomUUID(), userId: 'a', token, expiresAt: new Date(Date.now() + 3600_000) });
    const signature = createHmac('sha256', secret).update(token).digest('base64');
    const cookie = `${(await auth.$context).authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
    const request = (path: string) =>
      api.fetch(new Request(`${origin}/api/v1/${path}`, { headers: { origin, cookie } }));
    expect((await request('me')).status).toBe(200);
    expect((await request('developer-updates')).status).toBe(404);
  });

  it('retry the environment check after it fails, and then keep the same services', async () => {
    const getServices = createServices(defaultServerHooks);
    await expect(getServices()).rejects.toThrow('Database environment mismatch');
    await installed();
    const services = await getServices();
    expect(await getServices()).toBe(services);
  });

  it('leave the routes a 503 that is never cached, with CORS for the extension on its routes', async () => {
    const getServices = createServices(defaultServerHooks);
    const api = apiRoute(getServices);
    const auth = authRoute(getServices);
    for (const response of [
      await api(new Request(`${origin}/api/v1/sync`, { headers: { origin: extension } })),
      await auth(new Request(`${origin}/api/auth/oauth2/token`, { method: 'POST', headers: { origin: extension } })),
    ]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'service_unavailable' });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('access-control-allow-origin')).toBe(extension);
    }
    // Off the extension's routes, or from another origin, the 503 carries no CORS.
    const web = await api(new Request(`${origin}/api/v1/computers`, { headers: { origin: extension } }));
    expect(web.status).toBe(503);
    expect(web.headers.get('access-control-allow-origin')).toBeNull();
    const other = await api(new Request(`${origin}/api/v1/sync`, { headers: { origin: 'https://evil.test' } }));
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});
