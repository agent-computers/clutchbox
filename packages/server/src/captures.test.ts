import { createCipheriv, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { captureDigest } from '@agent-computers/capture';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundle, cookie, siteBundle } from './capture-fixtures';
import {
  adoptSyncSettings,
  captureKey,
  captureScope,
  captureView,
  changeSyncSettings,
  deleteCaptures,
  loadLatestCapture,
  openAppliedCapture,
  openCapture,
  saveCapture,
  sealAppliedCapture,
  sealCapture,
  syncView,
} from './captures';
import type { Database } from './database';
import { membership, person } from './member-fixtures';
import * as schema from './schema';

let pg: PGlite;
let db: Database;
const user = (id: string) => person(db, id);
// Migrate once per file; each test gets its own clone, which is much cheaper than a fresh database.
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
  const embedded = drizzle(pg, { schema });
  db = embedded as unknown as Database;
  vi.stubEnv('CAPTURE_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await pg.close();
});

// A value sealed for its person, as values were before memberships (version v1, retired).
function sealedForPerson(plaintext: string, purpose: string, userId: string, ...extra: string[]) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', captureKey()!, iv).setAAD(
    Buffer.from([`agent-computers/${purpose}/v1`, userId, ...extra].join(':')),
  );
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data]
    .map(part => (typeof part === 'string' ? part : part.toString('base64')))
    .join('.');
}
// Owners for the sealing tests alone, which touch no database.
const A = { userId: 'a', membershipId: 1 };
const B = { userId: 'b', membershipId: 2 };

describe('sealed captures', () => {
  it('round-trips and binds the ciphertext to its membership', () => {
    const capture = bundle([cookie(), cookie({ name: 'other', domain: '.github.com', hostOnly: false })]);
    const sealed = sealCapture(capture, A);
    expect(sealed).not.toContain('local');
    expect(sealed.startsWith('v2.')).toBe(true);
    expect(openCapture(sealed, A)).toEqual(capture);
    expect(() => openCapture(sealed, B)).toThrow();
    // The same person in another organization.
    expect(() => openCapture(sealed, { ...A, membershipId: 3 })).toThrow();
    const [version, iv, tag, data] = sealed.split('.');
    const flipped = Buffer.from(data!, 'base64');
    flipped[0]! ^= 1;
    expect(() => openCapture([version, iv, tag, flipped.toString('base64')].join('.'), A)).toThrow();
    expect(() => openCapture(sealed, A, randomBytes(32))).toThrow();
    // Truncated GCM tags are refused outright.
    expect(() =>
      openCapture([version, iv, Buffer.from(tag!, 'base64').subarray(0, 4).toString('base64'), data].join('.'), A),
    ).toThrow('invalid sealed capture');
  });
  it('refuses values sealed for the person, as before memberships (v1)', () => {
    const capture = bundle([cookie()]);
    expect(() => openCapture(sealedForPerson(JSON.stringify(capture), 'capture', 'a'), A)).toThrow(
      'invalid sealed capture',
    );
  });
  it('stores only digest and counts in plaintext, and skips unchanged uploads', async () => {
    const a = await user('a');
    const first = bundle([cookie()], new Date('2026-10-15T10:00:00Z'));
    expect(await saveCapture(db, a, first)).toEqual({
      status: 'stored',
      completedAt: '2026-10-15T10:00:00.000Z',
      cookieCount: 1,
    });
    const [row] = await db.select().from(schema.captures);
    expect(row).toMatchObject({ digest: await captureDigest(first.cookies), cookieCount: 1, captureId: first.id });
    expect(row!.sealed).not.toMatch(/example\.com|local/);
    const uploadedAt = row!.uploadedAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await saveCapture(db, a, bundle([cookie()], new Date('2026-10-15T10:15:00Z')))).toMatchObject({
      status: 'unchanged',
      completedAt: '2026-10-15T10:00:00.000Z',
    });
    const [after] = await db.select().from(schema.captures);
    expect(after!.sealed).toBe(row!.sealed);
    expect(after!.uploadedAt.getTime()).toBeGreaterThan(uploadedAt.getTime());
    // An upload received before the stored one commits late: refused, not reported as accepted.
    const newer = bundle([cookie({ value: 'newer' })], new Date('2026-10-15T11:00:00Z'));
    expect(await saveCapture(db, a, newer)).toMatchObject({ status: 'stored' });
    expect(
      await saveCapture(db, a, bundle([cookie({ value: 'older' })]), { receivedAt: new Date(Date.now() - 60_000) }),
    ).toEqual({ error: 'superseded' });
    expect((await loadLatestCapture(db, a))!.capture).toEqual(newer);
    expect(await captureView(db, a)).toMatchObject({ completedAt: '2026-10-15T11:00:00.000Z', cookieCount: 1 });
    // The client clock does not order uploads; a future capture time is clamped to receipt.
    const ahead = await saveCapture(db, a, bundle([cookie({ value: 'ahead' })], new Date(Date.now() + 7 * 86_400_000)));
    expect(ahead).toMatchObject({ status: 'stored' });
    expect(Date.parse((ahead as { completedAt: string }).completedAt)).toBeLessThanOrEqual(Date.now());
    expect(
      await saveCapture(db, a, bundle([cookie({ value: 'behind' })], new Date('2026-10-15T09:00:00Z'))),
    ).toMatchObject({ status: 'stored' });
    await deleteCaptures(db, a);
    expect(await captureView(db, a)).toBeNull();
  });
  it('keeps the scope sealed on its own and updates it when only the sites change', async () => {
    const a = await user('a');
    const b = await user('b');
    const cookies = [cookie({ domain: 'github.com' })];
    expect(await saveCapture(db, a, siteBundle(cookies, ['github.com']))).toMatchObject({ status: 'stored' });
    const [first] = await db.select().from(schema.captures);
    for (const sealed of [first!.sealed, first!.sealedScope]) expect(sealed).not.toMatch(/github|notion/);
    // A site added with no cookies yet: the cookie digest is unchanged, the scope is not.
    const added = await saveCapture(db, a, siteBundle(cookies, ['github.com', 'notion.so']));
    expect(added).toMatchObject({ status: 'unchanged' });
    const [after] = await db.select().from(schema.captures);
    expect(after).toMatchObject({ digest: first!.digest, sealed: first!.sealed });
    expect(after!.sealedScope).not.toBe(first!.sealedScope);
    expect(await captureScope(db, a)).toEqual({ mode: 'sites', sites: ['github.com', 'notion.so'] });
    // An upload received before the stored one never overwrites its scope.
    expect(
      await saveCapture(db, a, siteBundle(cookies, ['github.com']), { receivedAt: new Date(Date.now() - 60_000) }),
    ).toMatchObject({ status: 'unchanged' });
    expect(await captureScope(db, a)).toEqual({ mode: 'sites', sites: ['github.com', 'notion.so'] });
    // The scope is bound to its membership like the capture.
    await saveCapture(db, b, siteBundle(cookies, ['github.com']));
    const [sealedB] = await db
      .select({ sealedScope: schema.captures.sealedScope })
      .from(schema.captures)
      .where(eq(schema.captures.membershipId, b.membershipId));
    await db
      .update(schema.captures)
      .set({ sealedScope: sealedB!.sealedScope })
      .where(eq(schema.captures.membershipId, a.membershipId));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await captureScope(db, a)).toBe('unreadable');
    await deleteCaptures(db, a);
    expect(await captureScope(db, a)).toBeNull();
    expect(
      await db.select().from(schema.captures).where(eq(schema.captures.membershipId, a.membershipId)),
    ).toHaveLength(0);
  });
  it('answers sync_unavailable without a valid key', async () => {
    const a = await user('a');
    for (const key of ['', randomBytes(16).toString('base64')]) {
      vi.stubEnv('CAPTURE_ENCRYPTION_KEY', key);
      expect(await saveCapture(db, a, bundle([cookie()]))).toEqual({ error: 'sync_unavailable' });
    }
    expect(await db.select().from(schema.captures)).toHaveLength(0);
  });
  it('lets a deletion win over an upload received before it', async () => {
    const a = await user('a');
    const before = new Date();
    await new Promise(resolve => setTimeout(resolve, 5));
    await deleteCaptures(db, a);
    expect(await saveCapture(db, a, bundle([cookie()]), { receivedAt: before })).toEqual({ error: 'superseded' });
    expect(await captureView(db, a)).toBeNull();
    expect(await saveCapture(db, a, bundle([cookie()]))).toMatchObject({ status: 'stored' });
  });
  it('turns sync off after Delete everything until the extension reconnects', async () => {
    const a = await user('a');
    await saveCapture(db, a, bundle([cookie()]));
    await deleteCaptures(db, a, { disconnect: true });
    expect(await saveCapture(db, a, bundle([cookie()]))).toEqual({ error: 'sync_disconnected' });
    await deleteCaptures(db, a);
    expect(await saveCapture(db, a, bundle([cookie()]))).toEqual({ error: 'sync_disconnected' });
    expect(await captureView(db, a)).toBeNull();
    expect(await saveCapture(db, a, bundle([cookie()]), { connect: true })).toMatchObject({ status: 'stored' });
    expect(await saveCapture(db, a, bundle([cookie({ value: 'next' })]))).toMatchObject({ status: 'stored' });
  });
  it('records which connected browser sent the latest upload, and when each last synced', async () => {
    const a = await user('a');
    const [one, two] = await db
      .insert(schema.connectedBrowsers)
      .values(
        ['one', 'two'].map(name => ({
          publicId: `brw_${name}`,
          membershipId: a.membershipId,
          authorizationCodeId: name,
        })),
      )
      .returning({ id: schema.connectedBrowsers.id });
    const state = async () => ({
      sender: (await db.select().from(schema.captures))[0]?.connectedBrowserId ?? null,
      synced: Object.fromEntries(
        (await db.select().from(schema.connectedBrowsers)).map(row => [
          row.id,
          row.lastSyncedAt?.toISOString() ?? null,
        ]),
      ),
    });
    const t = (seconds: number) => new Date(Date.UTC(2026, 9, 21, 12, 0, seconds));
    const capture = bundle([cookie()], t(0));
    expect(await saveCapture(db, a, capture, { browser: one!.id, receivedAt: t(10) })).toMatchObject({
      status: 'stored',
    });
    expect(await state()).toEqual({ sender: one!.id, synced: { [one!.id]: t(10).toISOString(), [two!.id]: null } });
    // Unchanged cookies from the other browser: it becomes the sender.
    expect(await saveCapture(db, a, capture, { browser: two!.id, receivedAt: t(20) })).toMatchObject({
      status: 'unchanged',
    });
    expect((await state()).sender).toBe(two!.id);
    // An upload received earlier changes neither the sender nor the last sync time.
    expect(await saveCapture(db, a, capture, { browser: one!.id, receivedAt: t(5) })).toMatchObject({
      status: 'unchanged',
    });
    expect(await state()).toEqual({
      sender: two!.id,
      synced: { [one!.id]: t(10).toISOString(), [two!.id]: t(20).toISOString() },
    });
    // An app-auth upload names no browser.
    expect(await saveCapture(db, a, bundle([cookie({ value: 'next' })], t(30)), { receivedAt: t(30) })).toMatchObject({
      status: 'stored',
    });
    expect((await state()).sender).toBeNull();
  });
  it('refuses a disconnected browser even when it reconnects sync, and deletes only what a browser sent', async () => {
    const a = await user('a');
    const [one, two] = await db
      .insert(schema.connectedBrowsers)
      .values([
        { publicId: 'brw_one', membershipId: a.membershipId, authorizationCodeId: 'one' },
        { publicId: 'brw_two', membershipId: a.membershipId, authorizationCodeId: 'two', disconnectedAt: new Date() },
      ])
      .returning({ id: schema.connectedBrowsers.id });
    await deleteCaptures(db, a, { disconnect: true });
    expect(await saveCapture(db, a, bundle([cookie()]), { browser: two!.id, connect: true })).toEqual({
      error: 'sync_disconnected',
    });
    expect(await saveCapture(db, a, bundle([cookie()]), { browser: 999, connect: true })).toEqual({
      error: 'sync_disconnected',
    });
    expect((await syncView(db, a)).disconnected).toBe(true);
    expect(await saveCapture(db, a, bundle([cookie()]), { browser: one!.id, connect: true })).toMatchObject({
      status: 'stored',
    });
    await deleteCaptures(db, a, { uploadedBy: two!.id });
    expect(await captureView(db, a)).not.toBeNull();
    await deleteCaptures(db, a, { uploadedBy: one!.id });
    expect(await captureView(db, a)).toBeNull();
  });
});

describe('sync settings', () => {
  const serverSite = 'clutchbox.dev';
  const local = { sites: ['github.com', 'notion.so', serverSite], excludedDomains: ['bank.test'], paused: false };
  it("adopt an extension's settings only when the account has none, sealed and bound to the user", async () => {
    const a = await user('a');
    const b = await user('b');
    expect(await syncView(db, a)).toEqual({ settings: null, disconnected: false });
    // The Clutchbox site is never kept.
    const adopted = { ...local, sites: ['github.com', 'notion.so'] };
    expect(await adoptSyncSettings(db, a, local, serverSite)).toEqual(adopted);
    // A second browser gets the account's settings instead of overwriting them.
    expect(await adoptSyncSettings(db, a, { sites: ['x.com'], excludedDomains: [], paused: true }, serverSite)).toEqual(
      adopted,
    );
    expect((await syncView(db, a)).settings).toEqual(adopted);
    const [row] = await db.select().from(schema.syncSettings);
    expect(row!.sealed).not.toMatch(/github|bank/);
    // Another user's sealed settings don't open under this user.
    await adoptSyncSettings(db, b, local, serverSite);
    await db
      .update(schema.syncSettings)
      .set({ sealed: row!.sealed })
      .where(eq(schema.syncSettings.membershipId, b.membershipId));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await syncView(db, b)).settings).toBeNull();
  });
  it('apply changes, remove sites inside a new exclusion, and refuse changes before adoption', async () => {
    const a = await user('a');
    expect(await changeSyncSettings(db, a, { removeSites: ['github.com'] }, serverSite)).toEqual({
      error: 'sync_settings_missing',
    });
    await adoptSyncSettings(db, a, local, serverSite);
    expect(await changeSyncSettings(db, a, { addSites: ['x.com', 'twitter.com'], paused: true }, serverSite)).toEqual({
      sites: ['github.com', 'notion.so', 'twitter.com', 'x.com'],
      excludedDomains: ['bank.test'],
      paused: true,
    });
    expect(
      await changeSyncSettings(db, a, { removeSites: ['x.com'], excludedDomains: ['twitter.com'] }, serverSite),
    ).toEqual({ sites: ['github.com', 'notion.so'], excludedDomains: ['twitter.com'], paused: true });
    vi.stubEnv('CAPTURE_ENCRYPTION_KEY', '');
    expect(await changeSyncSettings(db, a, { paused: false }, serverSite)).toEqual({ error: 'sync_unavailable' });
  });
  it('store only what the settings allow, and narrow the stored capture when they change', async () => {
    const a = await user('a');
    const cookies = [
      cookie({ domain: 'github.com' }),
      cookie({ domain: 'notion.so' }),
      cookie({ domain: 'gist.github.com' }),
    ];
    // Before adoption, an upload is stored as sent.
    expect(await saveCapture(db, a, siteBundle(cookies, ['github.com', 'notion.so']))).toMatchObject({
      cookieCount: 3,
    });
    await adoptSyncSettings(db, a, { ...local, excludedDomains: [] }, serverSite);
    // Removing a site re-seals the stored copy without it, with a new digest so the next open applies it.
    const [before] = await db.select().from(schema.captures);
    await changeSyncSettings(db, a, { removeSites: ['notion.so'] }, serverSite);
    const [after] = await db.select().from(schema.captures);
    expect(after!.digest).not.toBe(before!.digest);
    expect(after!.uploadedAt).toEqual(before!.uploadedAt);
    expect(await captureScope(db, a)).toEqual({ mode: 'sites', sites: ['github.com'] });
    expect((await loadLatestCapture(db, a))!.capture.cookies.map(each => each.domain)).toEqual([
      'github.com',
      'gist.github.com',
    ]);
    // An exclusion inside an added site drops its cookies too.
    await changeSyncSettings(db, a, { excludedDomains: ['gist.github.com'] }, serverSite);
    expect((await loadLatestCapture(db, a))!.capture.cookies.map(each => each.domain)).toEqual(['github.com']);
    // A stale extension still uploading the removed site and excluded domain gets neither stored, and learns the
    // settings from the answer.
    const saved = await saveCapture(db, a, siteBundle(cookies, ['github.com', 'notion.so']));
    expect(saved).toMatchObject({
      cookieCount: 1,
      settings: { sites: ['github.com'], excludedDomains: ['gist.github.com'], paused: false },
    });
    expect(await captureScope(db, a)).toEqual({ mode: 'sites', sites: ['github.com'] });
    // All-sites captures keep every site but the excluded ones.
    await saveCapture(db, a, bundle([...cookies, cookie({ domain: 'other.test' })]));
    expect((await loadLatestCapture(db, a))!.capture.cookies.map(each => each.domain)).toEqual([
      'github.com',
      'notion.so',
      'other.test',
    ]);
    // Paused, uploads are refused with the settings, and the stored copy stays.
    await changeSyncSettings(db, a, { paused: true }, serverSite);
    expect(await saveCapture(db, a, bundle([cookie({ value: 'new' })]))).toEqual({
      error: 'sync_paused',
      settings: { sites: ['github.com'], excludedDomains: ['gist.github.com'], paused: true },
    });
    expect(await captureView(db, a)).toMatchObject({ cookieCount: 3 });
  });
  it('keep settings when sync is turned off, and forget them with Delete everything', async () => {
    const a = await user('a');
    await adoptSyncSettings(db, a, local, serverSite);
    await deleteCaptures(db, a, { disconnect: true });
    expect(await syncView(db, a)).toMatchObject({
      disconnected: true,
      settings: { sites: ['github.com', 'notion.so'] },
    });
    await deleteCaptures(db, a, { disconnect: true, forget: true });
    expect(await syncView(db, a)).toEqual({ settings: null, disconnected: true });
  });
});

describe('applied captures', () => {
  it('seals the applied capture to its membership and computer', () => {
    const applied = { completedAt: '2026-10-20T12:00:00.000Z', cookies: [cookie()] };
    const sealed = sealAppliedCapture(applied, A, 'computer-1');
    expect(sealed).not.toContain('local');
    expect(openAppliedCapture(sealed, A, 'computer-1')).toEqual(applied);
    expect(() => openAppliedCapture(sealed, B, 'computer-1')).toThrow();
    expect(() => openAppliedCapture(sealed, A, 'computer-2')).toThrow();
    expect(() => openCapture(sealed, A)).toThrow();
  });
});

describe('memberships', () => {
  it("keeps one person's capture, settings, and deletions apart in each of their memberships", async () => {
    const a = await user('a');
    // The same person in a second organization.
    const team = await membership(db, a.userId, (await user('b')).organizationId);
    const settings = { sites: ['example.com', 'github.com'], excludedDomains: [], paused: false };
    await adoptSyncSettings(db, a, settings, 'agent-computers.test');
    await saveCapture(
      db,
      a,
      siteBundle([cookie(), cookie({ name: 'gh', domain: 'github.com' })], ['example.com', 'github.com']),
    );
    await saveCapture(db, team, bundle([cookie({ value: 'team' })]));
    // The second membership has its own settings, which nothing adopted yet.
    expect((await syncView(db, team)).settings).toBeNull();
    expect(await changeSyncSettings(db, team, { removeSites: ['github.com'] }, 'agent-computers.test')).toEqual({
      error: 'sync_settings_missing',
    });
    expect((await loadLatestCapture(db, a))!.capture.cookies).toHaveLength(2);
    expect((await loadLatestCapture(db, team))!.capture.cookies.map(entry => entry.value)).toEqual(['team']);
    // Narrowing one membership's settings narrows only its capture.
    await changeSyncSettings(db, a, { removeSites: ['github.com'] }, 'agent-computers.test');
    expect((await loadLatestCapture(db, a))!.capture.cookies).toHaveLength(1);
    // Delete everything in the second membership leaves the first's capture, settings, and sync on.
    await deleteCaptures(db, team, { disconnect: true, forget: true });
    expect(await captureView(db, team)).toBeNull();
    expect(await saveCapture(db, team, bundle([cookie()]))).toEqual({ error: 'sync_disconnected' });
    expect(await captureView(db, a)).not.toBeNull();
    expect(await syncView(db, a)).toEqual({ settings: { ...settings, sites: ['example.com'] }, disconnected: false });
    expect(await saveCapture(db, a, bundle([cookie({ value: 'later' })]))).toMatchObject({ status: 'stored' });
  });
});
