import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundle, cookie, siteBundle } from './capture-fixtures';
import { saveCapture } from './captures';
import type { Database } from './database';
import { membership, person } from './member-fixtures';
import type { Member } from './organizations';
import * as schema from './schema';
import { closeSetupNotice, noteAgentConnected, noteSetupStep, recordSetupStep, resetSetup, setupView } from './setup';

let pg: PGlite;
let db: Database;
const user = (id: string) => person(db, id);
// A consent as Better Auth stores it, for a CIMD client.
async function consent(userId: string, { createdAt = new Date(), disabled = false, scopes = ['mcp:tools'] } = {}) {
  const clientId = `https://client.example.test/${randomUUID()}.json`;
  await db.insert(schema.oauthClient).values({ id: randomUUID(), clientId, redirectUris: [], disabled });
  await db
    .insert(schema.oauthConsent)
    .values({ id: randomUUID(), clientId, userId, scopes, createdAt, updatedAt: createdAt });
  return clientId;
}
const row = async (member: Member) =>
  (await db.select().from(schema.setups).where(eq(schema.setups.membershipId, member.membershipId)))[0];
// Migrate once per file and give each test a clone, which is much faster than a new database.
let template: PGlite;
beforeAll(async () => {
  template = new PGlite();
  await migrate(drizzle(template, { schema }), {
    migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
  });
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  db = drizzle(pg, { schema }) as unknown as Database;
  vi.stubEnv('CAPTURE_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await pg.close();
});

describe('setup progress', () => {
  it('records each first completion exactly once under concurrent callers, with or without a row', async () => {
    const a = await user('a');
    for (const step of ['browserSynced', 'agentConnected', 'setUp'] as const) {
      const results = await Promise.all(Array.from({ length: 5 }, () => recordSetupStep(db, a, step)));
      expect(
        results.filter(result => result.first),
        step,
      ).toHaveLength(1);
    }
    expect(await row(a)).toMatchObject({
      browserSyncedAt: expect.any(Date),
      agentConnectedAt: expect.any(Date),
      setUpAt: expect.any(Date),
      firstSetUpAt: expect.any(Date),
    });
  });
  it('emits one event per first completion, and none for users who existed before setup shipped', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = await user('a');
    const old = await user('old');
    await db.insert(schema.setups).values({ userId: old.userId, membershipId: old.membershipId, preexisting: true });
    for (const id of [a, old]) {
      await noteSetupStep(db, id, 'browserSynced');
      await noteSetupStep(db, id, 'browserSynced');
      await noteSetupStep(db, id, 'setUp');
    }
    expect(logged.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { user: 'a', event: 'setup.browserSynced' },
      { user: 'a', event: 'setup.setUp' },
    ]);
    expect(await row(old)).toMatchObject({ preexisting: true, browserSyncedAt: expect.any(Date) });
  });
  it('resets only the set-up state, and setting up again emits nothing', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = await user('a');
    for (const step of ['browserSynced', 'agentConnected', 'setUp'] as const) await noteSetupStep(db, a, step);
    await closeSetupNotice(db, a);
    const before = (await row(a))!;
    expect(before.noticeClosedAt).toBeInstanceOf(Date);
    await resetSetup(db, a);
    expect(await row(a)).toEqual({ ...before, setUpAt: null, noticeClosedAt: null, updatedAt: expect.any(Date) });
    // Closing the notice needs a set-up user.
    await closeSetupNotice(db, a);
    expect((await row(a))!.noticeClosedAt).toBeNull();
    expect(await recordSetupStep(db, a, 'setUp')).toMatchObject({ first: true, firstEver: false });
    expect((await row(a))!.setUpAt).toBeInstanceOf(Date);
    expect((await row(a))!.firstSetUpAt).toEqual(before.firstSetUpAt);
    expect(logged).toHaveBeenCalledTimes(3);
  });
  it('never throws when the write fails, and logs only the error class', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = await user('a');
    await pg.exec('DROP TABLE setups');
    expect(await noteSetupStep(db, a, 'setUp')).toBe(false);
    await noteAgentConnected(db, a);
    expect(errors.mock.calls.flat().join('\n')).toContain('setup setUp failed');
  });
  it('dates the agent step from the earliest live consent, not from the first call', async () => {
    const a = await user('a');
    await consent(a.userId, { createdAt: new Date('2026-10-01T00:00:00Z'), disabled: true });
    await consent(a.userId, { createdAt: new Date('2026-10-02T00:00:00Z'), scopes: ['openid'] });
    await consent(a.userId, { createdAt: new Date('2026-10-03T00:00:00Z') });
    await consent(a.userId, { createdAt: new Date('2026-10-04T00:00:00Z') });
    await noteAgentConnected(db, a);
    expect((await row(a))!.agentConnectedAt).toEqual(new Date('2026-10-03T00:00:00Z'));
  });
});

describe('setup view', () => {
  it('derives the checklist from the latest capture, live grants, and set-up state, per user', async () => {
    const a = await user('a');
    const b = await user('b');
    const empty = {
      setUpAt: null,
      noticeOpen: false,
      items: { browserSync: false, agents: false, computer: false },
      sync: { mode: null, sites: [], readable: true },
    };
    expect(await setupView(db, a)).toEqual(empty);
    // Agreed, but no site added yet.
    await saveCapture(db, a, siteBundle([], []));
    expect(await setupView(db, a)).toMatchObject({
      items: { browserSync: false },
      sync: { mode: 'sites', sites: [] },
    });
    // A site with no cookies still counts once its scope arrives.
    await saveCapture(db, a, siteBundle([], ['github.com']));
    expect(await setupView(db, a)).toMatchObject({
      items: { browserSync: true },
      sync: { mode: 'sites', sites: ['github.com'], readable: true },
    });
    await saveCapture(db, b, bundle([cookie()]));
    expect(await setupView(db, b)).toMatchObject({
      items: { browserSync: true },
      sync: { mode: 'whole-browser', sites: [] },
    });
    // Disabled clients do not count as connected.
    await consent(a.userId, { disabled: true });
    expect((await setupView(db, a)).items.agents).toBe(false);
    const connectedAt = new Date('2026-10-05T12:00:00Z');
    await consent(a.userId, { createdAt: connectedAt });
    expect((await setupView(db, a)).items.agents).toBe(true);
    // Viewing records the agent step for a grant whose agent has not called yet.
    expect((await row(a))!.agentConnectedAt).toEqual(connectedAt);
    await noteSetupStep(db, a, 'setUp');
    expect(await setupView(db, a)).toMatchObject({
      setUpAt: expect.any(String),
      noticeOpen: true,
      items: { browserSync: true, agents: true, computer: true },
    });
    await closeSetupNotice(db, a);
    expect((await setupView(db, a)).noticeOpen).toBe(false);
    expect((await setupView(db, b)).items).toEqual({ browserSync: true, agents: false, computer: false });
  });
  it('reports an unreadable capture as synced without listing it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = await user('a');
    await saveCapture(db, a, siteBundle([], ['github.com']));
    vi.stubEnv('CAPTURE_ENCRYPTION_KEY', '');
    expect(await setupView(db, a)).toMatchObject({
      items: { browserSync: true },
      sync: { mode: null, sites: [], readable: false },
    });
    expect(errors).toHaveBeenCalled();
  });
  it('lists no sites for a capture stored before the sealed scope existed, until the next upload', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = await user('a');
    const capture = siteBundle([cookie({ domain: 'github.com' })], ['github.com']);
    await saveCapture(db, a, capture);
    await db.update(schema.captures).set({ sealedScope: null });
    // Synced, but the cookies are never opened just to list sites.
    expect(await setupView(db, a)).toMatchObject({
      items: { browserSync: true },
      sync: { mode: null, sites: [], readable: false },
    });
    expect((await db.select().from(schema.captures))[0]!.sealedScope).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    expect(await saveCapture(db, a, capture)).toMatchObject({ status: 'unchanged' });
    expect((await setupView(db, a)).sync).toEqual({ mode: 'sites', sites: ['github.com'], readable: true });
  });
  it("keeps one person's setup apart in each of their memberships", async () => {
    const a = await user('a');
    const team = await membership(db, a.userId, (await user('b')).organizationId);
    await noteSetupStep(db, team, 'setUp');
    await saveCapture(db, team, siteBundle([], ['github.com']));
    expect((await setupView(db, a)).items).toMatchObject({ browserSync: false, computer: false });
    expect((await setupView(db, team)).items).toMatchObject({ browserSync: true, computer: true });
    await noteSetupStep(db, a, 'setUp');
    await resetSetup(db, a);
    expect((await row(team))?.setUpAt).not.toBeNull();
    expect((await row(a))?.setUpAt).toBeNull();
  });
});
