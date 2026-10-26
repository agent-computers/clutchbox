import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureRequestError, fetchCapture, listMembers } from '../../playwright/src/index';
import { latestCaptureForKey, MAX_API_KEYS } from '../../server/src/api-keys';
import { createAuth } from '../../server/src/auth';
import { bundle, cookie } from '../../server/src/capture-fixtures';
import { saveCapture } from '../../server/src/captures';
import type { ServerConfig } from '../../server/src/config';
import type { Database } from '../../server/src/database';
import { fakeComputerProvider } from '../../server/src/fake-computer-provider';
import { membership } from '../../server/src/member-fixtures';
import type { Role } from '../../server/src/members';
import { createOrganization, type Member } from '../../server/src/organizations';
import * as schema from '../../server/src/schema';
import { createApi } from './index';

// Organization API keys: who manages them, and what a key reads over the developer REST API (through the Playwright
// adapter's client, the way developers call it).
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
let acme: number;
let other: number;
beforeAll(async () => {
  template = new PGlite();
  await migrate(drizzle(template, { schema }), {
    migrationsFolder: fileURLToPath(new URL('../../server/migrations', import.meta.url)),
  });
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  db = drizzle(pg, { schema }) as unknown as Database;
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
  const response = await request(cookie, 'POST', '/organization/api-keys', { name: 'Ingest', scopes: ['captures'] });
  expect(response.status).toBe(201);
  return (await response.json()).key as { id: string; secret: string };
}

describe('organization API keys', () => {
  it('are created, listed, and revoked by owners and admins only, with the secret shown once', async () => {
    const admin = await person('admin', 'admin');
    const plain = await person('plain', 'member');
    expect((await request('', 'GET', '/organization/api-keys')).status).toBe(401);
    const body = { name: 'Ingest', scopes: ['captures'] };
    expect((await request(admin.cookie, 'POST', '/organization/api-keys', body, 'https://evil.test')).status).toBe(403);
    expect((await request(plain.cookie, 'POST', '/organization/api-keys', body)).status).toBe(403);
    expect((await request(plain.cookie, 'GET', '/organization/api-keys')).status).toBe(403);
    for (const bad of [
      {},
      { name: ' ', scopes: ['captures'] },
      { name: 'x', scopes: [] },
      { name: 'x', scopes: ['admin'] },
    ])
      expect((await request(admin.cookie, 'POST', '/organization/api-keys', bad)).status, JSON.stringify(bad)).toBe(
        400,
      );
    const key = await newKey(admin.cookie);
    expect(key).toMatchObject({ id: expect.stringMatching(/^key_/), secret: expect.stringMatching(/^ack_[\w-]{43}$/) });
    const listed = await (await request(admin.cookie, 'GET', '/organization/api-keys')).json();
    expect(listed.keys).toEqual([
      {
        id: key.id,
        name: 'Ingest',
        scopes: ['captures'],
        createdAt: expect.any(String),
        lastUsedAt: null,
        createdBy: 'Fixture admin',
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain(key.secret);
    const [stored] = await db.select({ tokenHash: schema.apiKeys.tokenHash }).from(schema.apiKeys);
    expect(stored!.tokenHash).not.toContain(key.secret.slice(4));
    // Another organization's owner can't revoke it.
    const stranger = await person('stranger2', 'owner', other);
    expect((await request(stranger.cookie, 'DELETE', `/organization/api-keys/${key.id}`)).status).toBe(404);
    expect((await request(plain.cookie, 'DELETE', `/organization/api-keys/${key.id}`)).status).toBe(403);
    expect((await request(admin.cookie, 'DELETE', '/organization/api-keys/nope')).status).toBe(400);
    expect((await request(admin.cookie, 'DELETE', `/organization/api-keys/${key.id}`)).status).toBe(200);
    expect((await request(admin.cookie, 'DELETE', `/organization/api-keys/${key.id}`)).status).toBe(404);
    expect((await (await request(admin.cookie, 'GET', '/organization/api-keys')).json()).keys).toEqual([]);
  });

  it(`stop at ${MAX_API_KEYS} live keys per organization`, async () => {
    const owner = await person('owner2', 'owner');
    const made = [];
    for (let i = 0; i < MAX_API_KEYS; i++) made.push(await newKey(owner.cookie));
    const refused = await request(owner.cookie, 'POST', '/organization/api-keys', {
      name: 'More',
      scopes: ['captures'],
    });
    expect([refused.status, await refused.json()]).toEqual([409, { error: 'api_key_limit' }]);
    await request(owner.cookie, 'DELETE', `/organization/api-keys/${made[0]!.id}`);
    await newKey(owner.cookie);
  });

  it("read the organization's members and their latest captures, and nothing of another organization", async () => {
    const admin = await person('admin', 'admin');
    const synced = await person('synced', 'member');
    const idle = await person('idle', 'member');
    const outsider = await person('outsider', 'owner', other);
    const capture = bundle([cookie({ name: 'session', value: 'synced-secret' })]);
    expect(await saveCapture(db, synced.member, capture)).not.toHaveProperty('error');
    await saveCapture(db, outsider.member, bundle([cookie()]));
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
    const [used] = await db.select({ lastUsedAt: schema.apiKeys.lastUsedAt }).from(schema.apiKeys);
    expect(used!.lastUsedAt).toBeInstanceOf(Date);
    // A member who leaves takes their capture with them.
    const leaver = await publicIdOf(synced.member);
    await db.delete(schema.memberships).where(eq(schema.memberships.id, synced.member.membershipId));
    expect(await failure(fetchCapture({ ...withKey(key.secret), member: leaver }))).toEqual([404, 'not_found']);
  });

  it('are refused at once when revoked or wrong, and only on the developer routes', async () => {
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
    await request(admin.cookie, 'DELETE', `/organization/api-keys/${key.id}`);
    expect(await failure(listMembers(withKey(key.secret)))).toEqual([401, 'unauthenticated']);
  });

  it('need the captures scope to read a capture', async () => {
    const synced = await person('synced', 'member');
    await saveCapture(db, synced.member, bundle([cookie()]));
    expect(
      await latestCaptureForKey(db, { keyId: 1, organizationId: acme, scopes: [] }, await publicIdOf(synced.member)),
    ).toEqual({ error: 'insufficient_scope' });
  });
});
