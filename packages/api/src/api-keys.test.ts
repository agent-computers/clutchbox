import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { databaseSchema } from '@agent-computers/server/database-schema';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureRequestError, fetchCapture, listMembers } from '../../playwright/src/index';
import { latestCaptureForKey } from '../../server/src/api-keys';
import { createAuth } from '../../server/src/auth';
import { saveFromBrowser } from '../../server/src/browser-fixtures';
import { bundle, cookie } from '../../server/src/capture-fixtures';
import type { ServerConfig } from '../../server/src/config';
import type { Database } from '../../server/src/database';
import { fakeComputerProvider } from '../../server/src/fake-computer-provider';
import { membership } from '../../server/src/member-fixtures';
import type { Role } from '../../server/src/members';
import { MAX_API_KEYS } from '../../server/src/organization-auth';
import { createOrganization, type Member } from '../../server/src/organizations';
import * as schema from '../../server/src/schema';
import { createApi } from './index';

// Organization API keys, Better Auth's api-key plugin's: who manages them through its endpoints (/api/auth/api-key),
// and what a key reads over the developer REST API (through the Playwright adapter's client, the way developers call
// it).
const origin = 'http://localhost:3098';
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
let acme: string;
let other: string;
beforeAll(async () => {
  template = new PGlite();
  await migrate(drizzle(template, { schema: databaseSchema }), {
    migrationsFolder: fileURLToPath(new URL('../../server/migrations', import.meta.url)),
  });
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  db = drizzle(pg, { schema: databaseSchema }) as unknown as Database;
  auth = createAuth(db, config);
  await auth.$context;
  vi.stubEnv('CAPTURE_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  for (const id of ['founder', 'stranger'])
    await db.insert(schema.user).values({ id, name: id, email: `${id}@acme.test`, emailVerified: true });
  acme = (await db.transaction(tx =>
    createOrganization(tx, { name: 'Acme', owner: { id: 'founder', name: 'founder', email: 'founder@acme.test' } }),
  ))!;
  other = (await db.transaction(tx =>
    createOrganization(tx, { name: 'Other', owner: { id: 'stranger', name: 'stranger', email: 'stranger@acme.test' } }),
  ))!;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

const api = () => createApi({ db, auth, origin, computers: fakeComputerProvider().provider });
// A signed-in person with a role in an organization.
async function person(id: string, role: Role, organizationId = acme) {
  await db
    .insert(schema.user)
    .values({ id, name: `Fixture ${id}`, email: `${id}@acme.test`, emailVerified: true })
    .onConflictDoNothing();
  const member = await membership(db, id, organizationId);
  await db.update(schema.memberships).set({ role }).where(eq(schema.memberships.id, member.membershipId));
  const token = randomBytes(32).toString('base64url');
  await db
    .insert(schema.session)
    .values({ id: randomUUID(), userId: id, token, expiresAt: new Date(Date.now() + 3600_000) });
  const signature = createHmac('sha256', config.BETTER_AUTH_SECRET).update(token).digest('base64');
  const cookie = `${(await auth.$context).authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
  return { cookie, member };
}
function request(cookie: string, method: string, path: string, body?: unknown, from = origin) {
  return api().request(`${origin}/api/v1${path}`, {
    method,
    headers: { cookie, origin: from, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
// A call to Better Auth's endpoints, as the web app's auth client makes it.
function authRequest(cookie: string, method: string, path: string, body?: unknown, from = origin) {
  return auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      method,
      headers: { cookie, origin: from, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
const createKey = (cookie: string, body: unknown, from = origin) =>
  authRequest(cookie, 'POST', '/api-key/create', body, from);
const listKeys = (cookie: string, organizationId = acme) =>
  authRequest(cookie, 'GET', `/api-key/list?organizationId=${organizationId}`);
const deleteKey = (cookie: string, keyId: string) => authRequest(cookie, 'POST', '/api-key/delete', { keyId });
const withKey = (apiKey: string) => ({
  server: origin,
  apiKey,
  fetch: ((url: URL | string, init?: RequestInit) => api().request(String(url), init)) as typeof fetch,
});
const publicIdOf = async (member: Member) =>
  (
    await db
      .select({ publicId: schema.memberships.publicId })
      .from(schema.memberships)
      .where(eq(schema.memberships.id, member.membershipId))
  )[0]!.publicId;
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    error => (error instanceof CaptureRequestError ? [error.status, error.code] : error),
  );
async function newKey(cookie: string) {
  const response = await createKey(cookie, { name: 'Ingest', organizationId: acme });
  expect(response.status).toBe(200);
  const { id, key } = await response.json();
  return { id: id as string, secret: key as string };
}

describe('organization API keys', () => {
  it('are created, listed, and deleted by owners and admins only, with the secret shown once', async () => {
    const admin = await person('admin', 'admin');
    const plain = await person('plain', 'member');
    const body = { name: 'Ingest', organizationId: acme };
    expect((await createKey('', body)).ok).toBe(false);
    expect((await createKey(admin.cookie, body, 'https://evil.test')).status).toBe(403);
    expect((await createKey(plain.cookie, body)).status).toBe(403);
    expect((await listKeys(plain.cookie)).status).toBe(403);
    for (const bad of [
      { organizationId: acme },
      { name: 'x'.repeat(101), organizationId: acme },
      { name: 'x', organizationId: acme, permissions: { admin: ['read'] } },
      { name: 'x', organizationId: acme, expiresIn: 60 },
    ])
      expect((await createKey(admin.cookie, bad)).status, JSON.stringify(bad)).toBe(400);
    const key = await newKey(admin.cookie);
    expect(key).toMatchObject({ id: expect.stringMatching(/^key_/), secret: expect.stringMatching(/^ack_\w+$/) });
    const listed = await (await listKeys(admin.cookie)).json();
    expect(listed.apiKeys).toEqual([
      expect.objectContaining({
        id: key.id,
        name: 'Ingest',
        referenceId: acme,
        permissions: { captures: ['read'], computers: ['read'] },
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(key.secret);
    const [stored] = await db.select({ key: schema.apikey.key }).from(schema.apikey);
    expect(stored!.key).not.toContain(key.secret.slice(4));
    // Another organization's owner can't see or delete it.
    const stranger = await person('stranger2', 'owner', other);
    expect((await listKeys(stranger.cookie)).status).toBe(403);
    expect((await deleteKey(stranger.cookie, key.id)).ok).toBe(false);
    expect((await deleteKey(plain.cookie, key.id)).ok).toBe(false);
    expect((await deleteKey(admin.cookie, key.id)).status).toBe(200);
    expect((await deleteKey(admin.cookie, key.id)).ok).toBe(false);
    expect((await (await listKeys(admin.cookie)).json()).apiKeys).toEqual([]);
  });

  it(`stop at ${MAX_API_KEYS} keys per organization`, async () => {
    const owner = await person('owner2', 'owner');
    const made = [];
    for (let i = 0; i < MAX_API_KEYS; i++) made.push(await newKey(owner.cookie));
    const refused = await createKey(owner.cookie, { name: 'More', organizationId: acme });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'api_key_limit' });
    await deleteKey(owner.cookie, made[0]!.id);
    await newKey(owner.cookie);
  });

  it("read the organization's members and their latest captures, and nothing of another organization", async () => {
    const admin = await person('admin', 'admin');
    const synced = await person('synced', 'member');
    const idle = await person('idle', 'member');
    const outsider = await person('outsider', 'owner', other);
    const capture = bundle([cookie({ name: 'session', value: 'synced-secret' })]);
    expect(await saveFromBrowser(db, synced.member, capture)).not.toHaveProperty('error');
    await saveFromBrowser(db, outsider.member, bundle([cookie()]));
    const key = await newKey(admin.cookie);

    const members = await listMembers(withKey(key.secret));
    expect(members.map(({ name, lastSyncedAt }) => [name, !!lastSyncedAt])).toEqual([
      ['founder', false],
      ['Fixture admin', false],
      ['Fixture synced', true],
      ['Fixture idle', false],
    ]);
    const fetched = await fetchCapture({ ...withKey(key.secret), member: await publicIdOf(synced.member) });
    expect(fetched.cookies).toEqual(capture.cookies);
    expect(fetched.completedAt).toBe(capture.completedAt);
    expect(await failure(fetchCapture({ ...withKey(key.secret), member: await publicIdOf(idle.member) }))).toEqual([
      404,
      'no_capture',
    ]);
    expect(await failure(fetchCapture({ ...withKey(key.secret), member: await publicIdOf(outsider.member) }))).toEqual([
      404,
      'not_found',
    ]);
    expect(await failure(fetchCapture({ ...withKey(key.secret), member: 'mem_x' }))).toEqual([400, 'invalid_request']);
    const [used] = await db.select({ lastRequest: schema.apikey.lastRequest }).from(schema.apikey);
    expect(used!.lastRequest).toBeInstanceOf(Date);
    // A member who leaves takes their capture with them.
    const leaver = await publicIdOf(synced.member);
    await db.delete(schema.memberships).where(eq(schema.memberships.id, synced.member.membershipId));
    expect(await failure(fetchCapture({ ...withKey(key.secret), member: leaver }))).toEqual([404, 'not_found']);
  });

  it('are refused at once when deleted or wrong, and only on the developer routes', async () => {
    const admin = await person('admin', 'admin');
    const key = await newKey(admin.cookie);
    expect(await listMembers(withKey(key.secret))).toHaveLength(2);
    // A key is no session: the app's routes refuse it, and the developer routes refuse a session.
    for (const path of ['/organization', '/computer', '/sync'])
      expect(
        (await api().request(`${origin}/api/v1${path}`, { headers: { authorization: `Bearer ${key.secret}` } })).status,
        path,
      ).toBe(401);
    expect(await (await request(admin.cookie, 'GET', '/members')).json()).toEqual({ error: 'api_key_required' });
    expect(await failure(listMembers(withKey(`ack_${'x'.repeat(43)}`)))).toEqual([401, 'unauthenticated']);
    await deleteKey(admin.cookie, key.id);
    expect(await failure(listMembers(withKey(key.secret)))).toEqual([401, 'unauthenticated']);
  });

  it('need the captures scope to read a capture', async () => {
    const synced = await person('synced', 'member');
    await saveFromBrowser(db, synced.member, bundle([cookie()]));
    expect(
      await latestCaptureForKey(
        db,
        { keyId: 'key_x', organizationId: acme, scopes: [] },
        await publicIdOf(synced.member),
      ),
    ).toEqual({ error: 'insufficient_scope' });
  });
});
