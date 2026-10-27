import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundle, cookie } from './capture-fixtures';
import { deleteCaptures, saveCapture } from './captures';
import {
  type Caller,
  type Computers,
  closeComputerSession,
  computerView,
  connectLiveView,
  DEFAULT_MAX_RUNNING_FORKS,
  deleteFork,
  deleteMainComputer,
  handBackComputer,
  listForks,
  liveViewAccess,
  liveViewHeartbeat,
  liveViewStatus,
  MAX_CLIPBOARD_BYTES,
  openComputerSession,
  SESSION_ID_PATTERN,
  setLiveViewClipboard,
  sweepForks,
  takeOverComputer,
  useComputerSession,
} from './computers';
import type { Database } from './database';
import { databaseSchema } from './database-schema';
import { fakeComputerProvider } from './fake-computer-provider';
import { heartbeat, heartbeatSchema } from './heartbeat';
import { type Metering, type MeteringRefusal, noMetering } from './hooks';
import { newPublicId } from './ids';
import { revokeMcpGrant, revokeMcpGrants } from './mcp';
import { membership, person } from './member-fixtures';
import type { Member } from './organizations';
import * as schema from './schema';
import { setTimeZone } from './time-zones';

let pg: PGlite;
let db: Database;
let fake: ReturnType<typeof fakeComputerProvider>;
// The metering hook as the computer service sees it: what it charged, by UTC month, and a refusal tests turn on.
let charges: { membershipId: number; month: string; seconds: number }[];
let refusal: MeteringRefusal | null;
const metering: Metering = {
  usage: async () => null,
  refusal: async () => refusal,
  charge: async (_tx, { membershipId }, seconds, now) => {
    charges.push({ membershipId, month: `${now.toISOString().slice(0, 7)}-01`, seconds });
  },
};
let computers: Computers;
const user = (id: string) => person(db, id);
const join = (userId: string, organizationId: string) => membership(db, userId, organizationId);
// The member's consent for an agent, bound to their membership as the consent page binds it.
const grant = async (member: Member, clientId: string) => {
  const [membership] = await db
    .select({ publicId: schema.memberships.publicId })
    .from(schema.memberships)
    .where(eq(schema.memberships.id, member.membershipId));
  await db.insert(schema.oauthConsent).values({
    id: randomUUID(),
    clientId,
    userId: member.userId,
    referenceId: membership!.publicId,
    scopes: ['mcp:tools'],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
};
const caller = (member: Member, clientId = 'client', guard?: Caller['guard']): Caller => ({
  ...member,
  clientId,
  guard,
});
// Opens and ends the open's own call, as the MCP layer does: a new fork, or with computerId (or the caller's own
// sessionId) a reopen.
const open = async (member: Member, clientId = 'client', sessionId?: string, computerId?: string) => {
  const opened = await openComputerSession(db, computers, caller(member, clientId), { sessionId, computerId });
  if ('error' in opened) throw new Error(opened.error);
  await opened.done();
  return opened;
};
const use = async (member: Member, sessionId: string, clientId = 'client') => {
  const handle = await useComputerSession(db, computers, caller(member, clientId), sessionId);
  if ('error' in handle) return handle;
  await handle.done();
  return handle;
};
const sessions = () => db.select().from(schema.computerSessions);
const sessionRow = async (publicId: string) =>
  (await db.select().from(schema.computerSessions).where(eq(schema.computerSessions.publicId, publicId)))[0]!;
// The latest computers row: the newest fork, or main before any.
const computerRow = async () =>
  (await db.select().from(schema.computers).orderBy(desc(schema.computers.id)).limit(1))[0]!;
const mainRow = async () => (await db.select().from(schema.computers).where(isNull(schema.computers.forkOf)))[0]!;
const forks = () => db.select().from(schema.computers).where(isNotNull(schema.computers.forkOf));
const forkRow = async (publicId: string) =>
  (await db.select().from(schema.computers).where(eq(schema.computers.publicId, publicId)))[0]!;
// The newest provider computer: the newest fork, or main before any.
const sandbox = () => [...fake.sandboxes.values()].at(-1)!;
const sandboxOf = async (publicId: string) => fake.sandboxes.get((await forkRow(publicId)).sandboxId!)!;
const mainSandbox = async () => fake.sandboxes.get((await mainRow()).sandboxId!)!;
const snapshotRows = () => db.select().from(schema.computerSnapshots).orderBy(schema.computerSnapshots.id);
const used = async (member: Member) => {
  const months = new Map<string, number>();
  for (const charge of charges.filter(entry => entry.membershipId === member.membershipId))
    months.set(charge.month, (months.get(charge.month) ?? 0) + charge.seconds);
  return [...months];
};
const at = (iso: string) => vi.setSystemTime(new Date(iso));
// Migrate once per file and give each test a clone, which is much faster than a new database.
let template: PGlite;
beforeAll(async () => {
  template = new PGlite();
  await migrate(drizzle(template, { schema: databaseSchema }), {
    migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
  });
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  db = drizzle(pg, { schema: databaseSchema }) as unknown as Database;
  fake = fakeComputerProvider();
  charges = [];
  refusal = null;
  computers = { provider: fake.provider, metering };
  // Computer sessions reference their OAuth client.
  await db
    .insert(schema.oauthClient)
    .values(
      ['client', 'claude', 'chatgpt', 'other', 'next'].map(clientId => ({ id: clientId, clientId, redirectUris: [] })),
    );
  vi.stubEnv('CAPTURE_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await pg.close();
});

describe('main computer', () => {
  it('creates exactly one main computer under concurrent first opens and reuses it', async () => {
    const a = await user('a');
    fake.slowCreate(50);
    const results = await Promise.all(Array.from({ length: 5 }, () => openComputerSession(db, computers, caller(a))));
    expect(fake.calls.create).toBe(1);
    const opened = results.filter(result => !('error' in result));
    expect(opened).toHaveLength(1);
    expect(
      results.filter(result => 'error' in result).every(result => 'error' in result && result.error === 'starting'),
    ).toBe(true);
    const first = opened[0]!;
    if ('error' in first) throw new Error(first.error);
    await first.done();
    await open(a);
    expect({ create: fake.calls.create, snapshot: fake.calls.snapshot, fork: fake.calls.fork }).toEqual({
      create: 1,
      snapshot: 1,
      fork: 2,
    });
  });
  it('reconciles a create whose result was never recorded instead of creating another', async () => {
    const a = await user('a');
    const [row] = await db
      .insert(schema.computers)
      .values({
        membershipId: a.membershipId,
        publicId: newPublicId('computer'),
        updatedAt: new Date(Date.now() - 10 * 60_000),
      })
      .returning();
    await fake.provider.create(row!.publicId, 60_000);
    await open(a);
    expect(fake.calls.create).toBe(1);
    expect(await mainRow()).toMatchObject({ status: 'ready', sandboxId: 'sandbox-1' });
  });
  it('deletes the main computer, its forks, and their snapshots, so the next open starts fresh', async () => {
    const a = await user('a');
    const first = await open(a);
    const mainId = (await mainRow()).id;
    expect(await deleteMainComputer(db, fake.provider, a)).toBe(true);
    expect(fake.calls.kill).toBe(2);
    expect(fake.sandboxes.size).toBe(0);
    expect(fake.snapshots.size).toBe(0);
    expect(await db.select().from(schema.computers)).toHaveLength(0);
    expect(await snapshotRows()).toHaveLength(0);
    expect(await useComputerSession(db, computers, caller(a), first.sessionId)).toMatchObject({
      error: 'session_not_found',
    });
    await open(a);
    expect((await mainRow()).id).not.toBe(mainId);
  });
  it('kills the computer an in-flight first open creates after a delete, instead of orphaning it', async () => {
    const a = await user('a');
    fake.slowCreate(200);
    const opening = openComputerSession(db, computers, caller(a));
    await vi.waitFor(async () => {
      expect(fake.calls.create).toBe(1);
      expect(await db.select().from(schema.computers)).toHaveLength(1);
    });
    await deleteMainComputer(db, fake.provider, a);
    expect(await opening).toMatchObject({ error: 'starting' });
    expect(fake.sandboxes.size).toBe(0);
    expect(fake.calls.kill).toBe(1);
    expect(await db.select().from(schema.computers)).toHaveLength(0);
    fake.slowCreate(0);
    await open(a);
    expect(fake.sandboxes.size).toBe(2);
  });
  it('keeps the computer a stale-create takeover recorded first and kills its own duplicate', async () => {
    const a = await user('a');
    fake.slowCreate(200);
    const opening = openComputerSession(db, computers, caller(a));
    await vi.waitFor(() => expect(fake.calls.create).toBe(1));
    // Another caller took over the stale create and recorded a different computer first.
    const [row] = await db
      .update(schema.computers)
      .set({ status: 'ready', sandboxId: 'recorded-elsewhere' })
      .where(eq(schema.computers.membershipId, a.membershipId))
      .returning();
    fake.sandboxes.set('recorded-elsewhere', {
      computerId: row!.publicId,
      actions: [],
      tabs: ['about:blank'],
      cookies: [],
      paused: false,
      revision: fake.provider.revision,
    });
    expect(await opening).toMatchObject({ sessionId: expect.stringMatching(SESSION_ID_PATTERN) });
    expect(fake.calls.kill).toBe(1);
    expect([...fake.sandboxes.keys()]).toEqual(['recorded-elsewhere', 'sandbox-2']);
    expect(await mainRow()).toMatchObject({ status: 'ready', sandboxId: 'recorded-elsewhere' });
  });
});

describe('memberships', () => {
  it("gives each of a person's memberships its own computers, sessions, live view, usage, and reset", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    // The same person in a second organization, as a member.
    const team = await join(a.userId, (await user('b')).organizationId);
    const personal = await open(a);
    const work = await open(team);
    expect({ create: fake.calls.create, fork: fake.calls.fork }).toEqual({ create: 2, fork: 2 });
    const rows = await db.select().from(schema.computers);
    expect(rows.map(row => row.membershipId).sort()).toEqual(
      [a.membershipId, a.membershipId, team.membershipId, team.membershipId].sort(),
    );
    // A session or fork works only for the membership that opened it, though the person and the agent are the same.
    for (const [member, sessionId] of [
      [team, personal.sessionId],
      [a, work.sessionId],
    ] as const)
      for (const action of [useComputerSession, closeComputerSession])
        expect(await action(db, computers, caller(member), sessionId)).toMatchObject({ error: 'session_not_found' });
    expect(await openComputerSession(db, computers, caller(team), { computerId: personal.computer.id })).toMatchObject({
      error: 'computer_not_found',
    });
    expect(await listForks(db, team)).toEqual([expect.objectContaining({ computerId: work.computer.id })]);
    // Usage is charged to the membership whose computer ran.
    at('2026-10-20T12:00:30Z');
    expect(await use(a, personal.sessionId)).not.toHaveProperty('error');
    expect(await used(a)).toEqual([['2026-10-01', 30]]);
    expect(await used(team)).toEqual([]);
    // Live view: taking over the team fork leaves the personal one to its agent.
    const page = randomUUID();
    const teamFork = { computerId: work.computer.id };
    expect(await takeOverComputer(db, computers, team, page, teamFork)).toMatchObject({ takeover: { mine: true } });
    expect(await use(team, work.sessionId)).toMatchObject({ error: 'user_in_control' });
    expect(await use(a, personal.sessionId)).not.toHaveProperty('error');
    expect(await liveViewAccess(db, team, page, undefined, teamFork)).toBe('control');
    expect(await liveViewAccess(db, a, page, undefined, teamFork)).toBe('none');
    expect(await setLiveViewClipboard(db, fake.provider, a, page, 'x', teamFork)).toBe('not_in_control');
    // Resetting one membership's computers leaves the other's and its session.
    expect(await deleteMainComputer(db, fake.provider, team)).toBe(true);
    expect((await db.select().from(schema.computers)).map(row => row.membershipId)).toEqual([
      a.membershipId,
      a.membershipId,
    ]);
    expect(await use(a, personal.sessionId)).not.toHaveProperty('error');
    expect(await computerView(db, metering, team)).toMatchObject({ computer: null });
  });
});

describe('forks', () => {
  const lease = () => randomUUID();
  it("creates a fork for each open from main's latest snapshot, with the latest capture, and runs them at once", async () => {
    const a = await user('a');
    await saveCapture(db, a, bundle([cookie()]));
    const claude = await openComputerSession(db, computers, caller(a, 'claude'), { label: 'Order history' });
    if ('error' in claude) throw new Error(claude.error);
    await claude.done();
    const chatgpt = await open(a, 'chatgpt');
    expect(claude.computer).toEqual({
      id: expect.stringMatching(/^cmp_/),
      label: 'Order history',
      created: true,
    });
    expect(chatgpt.computer).toMatchObject({ label: null, created: true });
    expect(chatgpt.computer.id).not.toBe(claude.computer.id);
    // One snapshot of main, which then pauses; each fork gets the capture and its own computer.
    expect({ create: fake.calls.create, snapshot: fake.calls.snapshot, fork: fake.calls.fork }).toEqual({
      create: 1,
      snapshot: 1,
      fork: 2,
    });
    expect(await mainSandbox()).toMatchObject({ paused: true, cookies: [] });
    for (const id of [claude.computer.id, chatgpt.computer.id]) {
      expect((await sandboxOf(id)).cookies.map(entry => entry.name)).toEqual(['sid']);
      expect(await forkRow(id)).toMatchObject({ status: 'ready', forkOf: (await mainRow()).id });
    }
    expect(claude.sync).toMatchObject({ status: 'applied', sitesUpdated: 1 });
    // Both sessions are live at once, each on its own fork.
    expect(await use(a, claude.sessionId, 'claude')).not.toHaveProperty('error');
    expect(await use(a, chatgpt.sessionId, 'chatgpt')).not.toHaveProperty('error');
    expect((await sessions()).filter(session => !session.endedAt)).toHaveLength(2);
  });
  it('reopens a fork by ID for any agent of the member, applying only captures newer than its last open', async () => {
    const a = await user('a');
    await saveCapture(db, a, bundle([cookie()]));
    const first = await open(a, 'claude');
    const id = first.computer.id;
    await closeComputerSession(db, computers, caller(a, 'claude'), first.sessionId);
    expect(await sandboxOf(id)).toMatchObject({ paused: true });
    (await sandboxOf(id)).tabs = ['https://example.com/work'];
    await saveCapture(db, a, bundle([cookie({ value: 'new' })], new Date('2026-10-20T11:00:00Z')));
    const reopened = await open(a, 'chatgpt', undefined, id);
    expect(reopened.computer).toEqual({ id, label: null, created: false });
    expect(reopened.sync).toMatchObject({ status: 'applied', sitesUpdated: 1 });
    // The same fork, resumed with its work, and the newest sign-in.
    expect(fake.calls.fork).toBe(1);
    expect(await sandboxOf(id)).toMatchObject({ paused: false, tabs: ['https://example.com/work'] });
    expect((await sandboxOf(id)).cookies.map(entry => entry.value)).toEqual(['new']);
    expect((await open(a, 'chatgpt', reopened.sessionId)).sync).toMatchObject({ status: 'unchanged' });
    expect(fake.calls.sync).toBe(2);
  });
  it("refuses another member's or organization's fork, and a malformed ID", async () => {
    const a = await user('a');
    const b = await user('b');
    const team = await join(a.userId, b.organizationId);
    const fork = await open(a, 'claude');
    for (const [member, computerId] of [
      [b, fork.computer.id],
      [team, fork.computer.id],
      [a, newPublicId('computer')],
      [a, 'not-a-computer'],
      [a, (await mainRow()).publicId],
    ] as const) {
      expect(await openComputerSession(db, computers, caller(member, 'claude'), { computerId })).toMatchObject({
        error: 'computer_not_found',
      });
      expect(await deleteFork(db, computers, caller(member, 'claude'), computerId)).toMatchObject({
        error: 'computer_not_found',
      });
      expect(await takeOverComputer(db, computers, member, lease(), { computerId })).toMatchObject({
        error: 'computer_not_found',
      });
    }
    expect(await sessionRow(fork.sessionId)).toMatchObject({ endedAt: null });
  });
  it('gives busy to a second open of a fork that a computer session controls, until its idle minute ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const first = await open(a, 'claude');
    const id = first.computer.id;
    at('2026-10-20T12:00:30Z');
    // Another agent, or another conversation of the same client without the session_id.
    for (const clientId of ['chatgpt', 'claude'])
      expect(await openComputerSession(db, computers, caller(a, clientId), { computerId: id })).toMatchObject({
        error: 'busy',
        busyUntil: new Date('2026-10-20T12:01:00Z'),
      });
    expect(await use(a, first.sessionId, 'claude')).not.toHaveProperty('error');
    at('2026-10-20T12:01:20Z');
    expect(await openComputerSession(db, computers, caller(a, 'chatgpt'), { computerId: id })).toMatchObject({
      error: 'busy',
      busyUntil: new Date('2026-10-20T12:01:30Z'),
    });
    expect(await listForks(db, a)).toEqual([expect.objectContaining({ computerId: id, status: 'in_use' })]);
    // Its idle minute over, it paused.
    at('2026-10-20T12:01:31Z');
    expect(await listForks(db, a)).toEqual([expect.objectContaining({ status: 'paused' })]);
    const second = await open(a, 'chatgpt', undefined, id);
    expect(await sessionRow(first.sessionId)).toMatchObject({ endReason: 'superseded' });
    expect(await use(a, first.sessionId, 'claude')).toMatchObject({ error: 'session_ended' });
    expect(await use(a, second.sessionId, 'chatgpt')).not.toHaveProperty('error');
  });
  it("replaces the caller's own session on its fork when computer_open is given its session_id", async () => {
    const a = await user('a');
    const first = await open(a, 'claude');
    const second = await open(a, 'claude', first.sessionId);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.computer).toMatchObject({ id: first.computer.id, created: false });
    expect(await sessionRow(first.sessionId)).toMatchObject({ endReason: 'replaced' });
    expect(await use(a, first.sessionId, 'claude')).toMatchObject({ error: 'session_ended' });
    // Another client cannot use a session_id it learned to take over: it gets a fork of its own.
    const other = await open(a, 'chatgpt', second.sessionId);
    expect(other.computer).toMatchObject({ created: true });
    expect(await sessionRow(second.sessionId)).toMatchObject({ endedAt: null });
  });
  it('never lets an agent control the main computer', async () => {
    const a = await user('a');
    await open(a);
    // A session on main from before forks.
    const legacy = newPublicId('computerSession');
    await db.insert(schema.computerSessions).values({
      publicId: legacy,
      membershipId: a.membershipId,
      clientId: 'claude',
      computerId: (await mainRow()).id,
      lastCallAt: new Date(),
    });
    for (const action of [useComputerSession, closeComputerSession])
      expect(await action(db, computers, caller(a, 'claude'), legacy)).toMatchObject({ error: 'session_ended' });
    // Passing it to computer_open gives the agent a new fork instead.
    expect((await open(a, 'claude', legacy)).computer).toMatchObject({ created: true });
    expect(await mainSandbox()).toMatchObject({ paused: true });
  });
  it('gives the next new fork what the member signed in to by taking over main, at the hand-back or a lapse', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const before = await open(a);
    const page = lease();
    await takeOverComputer(db, computers, a, page);
    // The member signs in on main.
    (await mainSandbox()).cookies.push({
      name: 'session',
      value: 'member',
      url: 'https://bank.test/',
      path: '/',
      secure: true,
      httpOnly: true,
    });
    expect(await mainRow()).toMatchObject({ snapshotDueAt: null });
    at('2026-10-20T12:00:30Z');
    await handBackComputer(db, computers, a, page);
    expect(fake.calls.snapshot).toBe(2);
    expect(await mainRow()).toMatchObject({ snapshotDueAt: null, snapshotId: (await snapshotRows())[1]!.id });
    const after = await open(a);
    expect((await sandboxOf(after.computer.id)).cookies.map(entry => entry.name)).toEqual(['session']);
    // A fork made before keeps its own state: nothing flows between computers.
    expect((await sandboxOf(before.computer.id)).cookies).toEqual([]);
    // A takeover that lapses without a hand-back: the next fork snapshots main first.
    await takeOverComputer(db, computers, a, page);
    (await mainSandbox()).cookies.push({
      name: 'later',
      value: 'member',
      url: 'https://shop.test/',
      path: '/',
      secure: true,
      httpOnly: true,
    });
    at('2026-10-20T12:05:00Z');
    const lapsed = await open(a);
    expect(fake.calls.snapshot).toBe(3);
    expect((await sandboxOf(lapsed.computer.id)).cookies.map(entry => entry.name).sort()).toEqual(['later', 'session']);
    // No takeover since: the next fork uses the same snapshot.
    await open(a);
    expect(fake.calls.snapshot).toBe(3);
  });
  it('waits for a takeover of main to end before its first snapshot, and never snapshots during one', async () => {
    const a = await user('a');
    const page = lease();
    await takeOverComputer(db, computers, a, page);
    expect(await openComputerSession(db, computers, caller(a))).toMatchObject({ error: 'busy' });
    expect(fake.calls.snapshot).toBe(0);
    await handBackComputer(db, computers, a, page);
    await open(a);
    // A later takeover: forks start from the previous snapshot meanwhile.
    await takeOverComputer(db, computers, a, page);
    await db.update(schema.computers).set({ snapshotDueAt: new Date() }).where(isNull(schema.computers.forkOf));
    await open(a);
    expect({ snapshot: fake.calls.snapshot, fork: fake.calls.fork }).toEqual({ snapshot: 1, fork: 2 });
  });
  it('keeps the previous snapshot when a new one fails, and fails the first fork without one', async () => {
    const a = await user('a');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.failSnapshot();
    await expect(openComputerSession(db, computers, caller(a))).rejects.toThrow('snapshot failed');
    expect(await forks()).toEqual([]);
    expect(await sessions()).toEqual([]);
    fake.failSnapshot(false);
    await open(a);
    const page = lease();
    await takeOverComputer(db, computers, a, page);
    fake.failSnapshot();
    await handBackComputer(db, computers, a, page);
    expect(error).toHaveBeenCalled();
    expect((await mainRow()).snapshotDueAt).not.toBeNull();
    // The next fork starts from the previous snapshot, and the one after retries the new one.
    await open(a);
    expect(await snapshotRows()).toHaveLength(1);
    fake.failSnapshot(false);
    await open(a);
    expect(await snapshotRows()).toHaveLength(2);
    expect((await mainRow()).snapshotDueAt).toBeNull();
  });
  it('deletes a superseded snapshot once the last fork made from it is deleted, and at once without one', async () => {
    const a = await user('a');
    const page = lease();
    const first = await open(a, 'claude');
    const [s1] = await snapshotRows();
    // A takeover supersedes the first snapshot, which the fork still uses, so the provider keeps it.
    await takeOverComputer(db, computers, a, page);
    await handBackComputer(db, computers, a, page);
    expect((await snapshotRows()).map(row => row.providerSnapshotId)).toEqual([s1!.providerSnapshotId, 'snapshot-2']);
    expect(fake.snapshots.has(s1!.providerSnapshotId)).toBe(true);
    // Another takeover supersedes the second, which no fork used: deleted with it.
    await takeOverComputer(db, computers, a, page);
    await handBackComputer(db, computers, a, page);
    expect((await snapshotRows()).map(row => row.providerSnapshotId)).toEqual([s1!.providerSnapshotId, 'snapshot-3']);
    expect([...fake.snapshots.keys()].sort()).toEqual([s1!.providerSnapshotId, 'snapshot-3']);
    // Deleting the last fork made from the first deletes it too; main's latest stays.
    expect(await deleteFork(db, computers, caller(a, 'claude'), first.computer.id)).toEqual({ deleted: true });
    expect((await snapshotRows()).map(row => row.providerSnapshotId)).toEqual(['snapshot-3']);
    expect([...fake.snapshots.keys()]).toEqual(['snapshot-3']);
  });
  it('retries a snapshot the provider would not delete in a later sweep', async () => {
    const a = await user('a');
    const page = lease();
    const first = await open(a, 'claude');
    await takeOverComputer(db, computers, a, page);
    await handBackComputer(db, computers, a, page);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The delete's own attempt and its sweep's both fail.
    const deleteSnapshot = vi
      .spyOn(fake.provider, 'deleteSnapshot')
      .mockRejectedValueOnce(new Error('busy'))
      .mockRejectedValueOnce(new Error('busy'));
    await deleteFork(db, computers, caller(a, 'claude'), first.computer.id);
    expect(await snapshotRows()).toHaveLength(2);
    await sweepForks(db, fake.provider);
    expect(deleteSnapshot).toHaveBeenCalledTimes(3);
    expect(await snapshotRows()).toHaveLength(1);
  });
  it("caps the organization's running forks, with busy until the first is due to pause", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const b = await join((await user('b-person')).userId, a.organizationId);
    const other = await user('c');
    await db
      .update(schema.organizations)
      .set({ maxRunningForks: 2 })
      .where(eq(schema.organizations.publicId, a.organizationId));
    const first = await open(a, 'claude');
    at('2026-10-20T12:00:10Z');
    await open(b, 'claude');
    at('2026-10-20T12:00:20Z');
    // A third fork in the organization, from either member, waits for the first to pause (its idle minute).
    for (const member of [a, b])
      expect(await openComputerSession(db, computers, caller(member, 'chatgpt'))).toMatchObject({
        error: 'busy',
        busyUntil: new Date('2026-10-20T12:01:00Z'),
      });
    expect(fake.calls.fork).toBe(2);
    // Another organization has its own cap, and reopening a running fork adds none.
    await open(other, 'claude');
    expect(await open(a, 'claude', first.sessionId)).toHaveProperty('sessionId');
    // A closed fork pauses, which frees its place.
    const reopened = (await sessions()).find(session => !session.endedAt && session.membershipId === a.membershipId)!;
    await closeComputerSession(db, computers, caller(a, 'claude'), reopened.publicId);
    const third = await open(a, 'chatgpt');
    // Reopening a paused fork counts too.
    expect(
      await openComputerSession(db, computers, caller(a, 'claude'), { computerId: first.computer.id }),
    ).toMatchObject({ error: 'busy' });
    await closeComputerSession(db, computers, caller(a, 'chatgpt'), third.sessionId);
    expect(await open(a, 'claude', undefined, first.computer.id)).toHaveProperty('sessionId');
    // Without a cap of its own, an organization gets the default.
    await db.update(schema.organizations).set({ maxRunningForks: null });
    for (let i = 1; i < DEFAULT_MAX_RUNNING_FORKS; i++) await open(other, 'claude');
    expect(await openComputerSession(db, computers, caller(other, 'claude'))).toMatchObject({ error: 'busy' });
  });
  it("lists the member's forks with their status, and deletes one with what was on it", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const b = await user('b');
    const first = await openComputerSession(db, computers, caller(a, 'claude'), { label: 'Invoices' });
    if ('error' in first) throw new Error(first.error);
    await first.done();
    at('2026-10-20T12:00:10Z');
    const second = await open(a, 'chatgpt');
    await closeComputerSession(db, computers, caller(a, 'chatgpt'), second.sessionId);
    await open(b, 'claude');
    expect(await listForks(db, a)).toEqual([
      {
        computerId: second.computer.id,
        label: null,
        createdAt: '2026-10-20T12:00:10.000Z',
        lastUsedAt: '2026-10-20T12:00:10.000Z',
        status: 'paused',
      },
      {
        computerId: first.computer.id,
        label: 'Invoices',
        createdAt: '2026-10-20T12:00:00.000Z',
        lastUsedAt: '2026-10-20T12:00:00.000Z',
        status: 'in_use',
      },
    ]);
    // Another agent's session holding it means busy; the agent's own just ends.
    expect(await deleteFork(db, computers, caller(a, 'chatgpt'), first.computer.id)).toMatchObject({
      error: 'busy',
      busyUntil: new Date('2026-10-20T12:01:00Z'),
    });
    const sandboxId = (await forkRow(first.computer.id)).sandboxId!;
    expect(await deleteFork(db, computers, caller(a, 'claude'), first.computer.id)).toEqual({ deleted: true });
    expect(fake.sandboxes.has(sandboxId)).toBe(false);
    expect(await useComputerSession(db, computers, caller(a, 'claude'), first.sessionId)).toMatchObject({
      error: 'session_not_found',
    });
    expect((await listForks(db, a)).map(fork => fork.computerId)).toEqual([second.computer.id]);
    // A user's takeover of a fork means busy too.
    const page = lease();
    await takeOverComputer(db, computers, a, page, { computerId: second.computer.id });
    expect(await deleteFork(db, computers, caller(a, 'claude'), second.computer.id)).toMatchObject({ error: 'busy' });
  });
  it('deletes forks unused for 7 days, and abandoned creates, when a close or delete sweeps', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-01T12:00:00Z');
    const a = await user('a');
    const b = await user('b');
    const old = await open(a);
    await closeComputerSession(db, computers, caller(a), old.sessionId);
    at('2026-10-05T12:00:00Z');
    const recent = await open(a);
    await closeComputerSession(db, computers, caller(a), recent.sessionId);
    // A create whose request died.
    const [main] = await db.select().from(schema.computers).where(isNull(schema.computers.forkOf));
    const abandoned = newPublicId('computer');
    await db.insert(schema.computers).values({
      publicId: abandoned,
      membershipId: a.membershipId,
      forkOf: main!.id,
      snapshotId: main!.snapshotId,
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    });
    await fake.provider.createFromSnapshot('snapshot-1', abandoned, 60_000);
    // Any member's close sweeps the deployment.
    at('2026-10-08T12:00:01Z');
    const other = await open(b);
    await closeComputerSession(db, computers, caller(b), other.sessionId);
    expect((await listForks(db, a)).map(fork => fork.computerId)).toEqual([recent.computer.id]);
    expect([...fake.sandboxes.values()].map(entry => entry.computerId)).not.toContain(old.computer.id);
    expect([...fake.sandboxes.values()].map(entry => entry.computerId)).not.toContain(abandoned);
    // One opened since is kept.
    at('2026-10-12T13:00:00Z');
    await sweepForks(db, fake.provider);
    expect((await listForks(db, a)).map(fork => fork.computerId)).toEqual([]);
    expect(await listForks(db, b)).toHaveLength(1);
  });
  it('deletes a fork whose create failed, with its session, so nothing is left behind', async () => {
    const a = await user('a');
    fake.failCreateFromSnapshot();
    await expect(openComputerSession(db, computers, caller(a))).rejects.toThrow('createFromSnapshot failed');
    expect(await forks()).toEqual([]);
    expect(await sessions()).toEqual([]);
    fake.failCreateFromSnapshot(false);
    expect(await open(a)).toHaveProperty('sessionId');
  });
  it('clears what each snapshot had applied when captures are deleted, so new forks apply the next one wholesale', async () => {
    const a = await user('a');
    await saveCapture(db, a, bundle([cookie()]));
    const page = lease();
    await takeOverComputer(db, computers, a, page);
    await handBackComputer(db, computers, a, page);
    expect((await snapshotRows())[0]).toMatchObject({ appliedCaptureDigest: expect.any(String) });
    await deleteCaptures(db, a);
    expect((await snapshotRows())[0]).toMatchObject({ appliedCaptureDigest: null, appliedCapture: null });
    await saveCapture(db, a, bundle([cookie({ value: 'again' })]));
    const fork = await open(a);
    expect(fork.sync).toMatchObject({ status: 'applied', sitesUpdated: 1 });
    expect((await sandboxOf(fork.computer.id)).cookies.map(entry => entry.value)).toEqual(['again']);
  });
});

describe('computer sessions', () => {
  it('issues an opaque session ID that works only for the user and client that opened it', async () => {
    const a = await user('a');
    const b = await user('b');
    const opened = await open(a, 'claude');
    expect(opened.sessionId).toMatch(SESSION_ID_PATTERN);
    expect(opened.sessionId).not.toContain(opened.computer.id.slice(4));
    expect(await use(a, opened.sessionId, 'claude')).not.toHaveProperty('error');
    for (const [userId, clientId, sessionId] of [
      [b, 'claude', opened.sessionId],
      [a, 'chatgpt', opened.sessionId],
      [a, 'claude', `cs_${randomBytes(32).toString('base64url')}`],
      [a, 'claude', newPublicId('computerSession')],
      [a, 'claude', 'not-a-session'],
      [a, 'claude', opened.computer.id],
    ] as const)
      for (const action of [useComputerSession, closeComputerSession])
        expect(await action(db, computers, caller(userId, clientId), sessionId)).toMatchObject({
          error: 'session_not_found',
        });
    // Nothing above ended or touched the session.
    expect(await sessionRow(opened.sessionId)).toMatchObject({ endedAt: null });
    expect((await computerRow()).callsInFlight).toEqual({});
  });
  it('ends the session of an open that failed to reach the computer, so a retry is not busy', async () => {
    const a = await user('a');
    vi.spyOn(fake.provider, 'connect').mockRejectedValueOnce(new Error('unreachable'));
    await expect(openComputerSession(db, computers, caller(a))).rejects.toThrow('unreachable');
    expect(await sessions()).toEqual([expect.objectContaining({ endReason: 'closed' })]);
    expect((await computerRow()).callsInFlight).toEqual({});
    const [fork] = await forks();
    expect(await open(a, 'client', undefined, fork!.publicId)).toHaveProperty('sessionId');
  });
  it('holds control for a call in flight past the idle minute, until the call ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const first = await open(a, 'claude');
    const call = await useComputerSession(db, computers, caller(a, 'claude'), first.sessionId);
    if ('error' in call) throw new Error(call.error);
    at('2026-10-20T12:01:30Z');
    expect(
      await openComputerSession(db, computers, caller(a, 'chatgpt'), { computerId: first.computer.id }),
    ).toMatchObject({
      error: 'busy',
      busyUntil: new Date('2026-10-20T12:02:40Z'),
    });
    await call.done();
    await call.done();
    expect(await sessionRow(first.sessionId)).toMatchObject({ lastCallAt: new Date('2026-10-20T12:01:30Z') });
    expect((await computerRow()).callsInFlight).toEqual({});
    at('2026-10-20T12:02:31Z');
    expect(await open(a, 'chatgpt', undefined, first.computer.id)).toHaveProperty('sessionId');
  });
  it('ends a session after 10 idle minutes, and a session idle less resumes without busy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const opened = await open(a);
    at('2026-10-20T12:09:59Z');
    expect(await use(a, opened.sessionId)).not.toHaveProperty('error');
    at('2026-10-20T12:20:00Z');
    expect(await use(a, opened.sessionId)).toMatchObject({ error: 'session_ended' });
    expect(await sessionRow(opened.sessionId)).toMatchObject({ endReason: 'idle' });
    expect(await closeComputerSession(db, computers, caller(a), opened.sessionId)).toMatchObject({
      error: 'session_ended',
    });
    // Its fork stays, for a reopen.
    expect((await open(a, 'client', opened.sessionId)).computer).toMatchObject({ id: opened.computer.id });
  });
  it('starts and uses no session when the guard finds the access revoked', async () => {
    const a = await user('a');
    const revokedCaller = caller(a, 'claude', async () => false);
    expect(await openComputerSession(db, computers, revokedCaller)).toMatchObject({ error: 'access_revoked' });
    expect(await sessions()).toHaveLength(0);
    expect(await forks()).toHaveLength(0);
    const opened = await open(a, 'claude');
    expect(await openComputerSession(db, computers, revokedCaller, { computerId: opened.computer.id })).toMatchObject({
      error: 'access_revoked',
    });
    expect(await deleteFork(db, computers, revokedCaller, opened.computer.id)).toMatchObject({
      error: 'access_revoked',
    });
    for (const action of [useComputerSession, closeComputerSession])
      expect(await action(db, computers, revokedCaller, opened.sessionId)).toMatchObject({ error: 'access_revoked' });
    expect(await sessionRow(opened.sessionId)).toMatchObject({ endedAt: null });
    expect((await computerRow()).callsInFlight).toEqual({});
  });
  it("revoking an agent ends its sessions, and only that agent's", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const clientId = 'https://client.example.test/agent.json';
    await db.insert(schema.oauthClient).values({ id: randomUUID(), clientId, redirectUris: [] });
    await grant(a, clientId);
    const other = await open(a, 'other');
    expect(await revokeMcpGrant(db, a, clientId)).toBe(true);
    expect(await sessionRow(other.sessionId)).toMatchObject({ endedAt: null });
    at('2026-10-20T12:01:01Z');
    const agent = await open(a, clientId);
    await grant(a, clientId);
    expect(await revokeMcpGrant(db, a, clientId)).toBe(true);
    expect(await sessionRow(agent.sessionId)).toMatchObject({ endReason: 'revoked' });
    // Only the guard reports the revocation; once the agent is reconnected, its old session is just ended.
    expect(
      await useComputerSession(
        db,
        computers,
        caller(a, clientId, async () => false),
        agent.sessionId,
      ),
    ).toMatchObject({ error: 'access_revoked' });
    for (const action of [useComputerSession, closeComputerSession])
      expect(
        await action(
          db,
          computers,
          caller(a, clientId, async () => true),
          agent.sessionId,
        ),
      ).toMatchObject({
        error: 'session_ended',
      });
    // A revoked session no longer holds control of its fork, and revoking every agent ends the rest.
    expect(await open(a, 'next', undefined, agent.computer.id)).toHaveProperty('sessionId');
    await revokeMcpGrants(db, a);
    expect((await sessions()).filter(session => !session.endedAt)).toEqual([]);
  });
});

describe('per-call hold and metering', () => {
  it('holds each call for its budget plus the idle minute, and meters the running time after the fact', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const opened = await openComputerSession(db, computers, caller(a));
    if ('error' in opened) throw new Error(opened.error);
    // Main's create and its snapshot cover the idle minute, and main pauses right after; the fork's create and the
    // open's connect hold it for 160s. Nothing is charged ahead.
    expect(fake.calls.timeouts).toEqual([60_000, 60_000, 160_000, 160_000]);
    expect(fake.calls.pause).toBe(1);
    expect(await used(a)).toEqual([]);
    await opened.done();
    expect(fake.calls.setTimeouts).toEqual([60_000]);
    expect((await computerRow()).runsUntil).toEqual(new Date('2026-10-20T12:01:00Z'));
    expect((await mainRow()).runsUntil).toEqual(new Date('2026-10-20T12:00:00Z'));
    at('2026-10-20T12:00:30Z');
    await use(a, opened.sessionId);
    expect(await used(a)).toEqual([['2026-10-01', 30]]);
    // After the computer paused, the next call books the idle minute it ran (to 12:01:30), not the pause.
    at('2026-10-20T12:05:00Z');
    expect(await use(a, opened.sessionId)).not.toHaveProperty('error');
    expect(await used(a)).toEqual([['2026-10-01', 90]]);
  });
  it('lets only the last of overlapping calls shorten the timeout to the idle minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const opened = await open(a);
    const long = await useComputerSession(db, computers, caller(a), opened.sessionId);
    const short = await useComputerSession(db, computers, caller(a), opened.sessionId);
    if ('error' in long || 'error' in short) throw new Error('call failed');
    at('2026-10-20T12:00:05Z');
    await short.done();
    // The long call's deadline (12:01:40) plus the idle minute.
    expect(fake.calls.setTimeouts).toEqual([60_000, 155_000]);
    expect(await sessionRow(opened.sessionId)).toMatchObject({ lastCallAt: new Date('2026-10-20T12:01:40Z') });
    at('2026-10-20T12:01:20Z');
    await long.done();
    expect(fake.calls.setTimeouts).toEqual([60_000, 155_000, 60_000]);
    expect((await computerRow()).runsUntil).toEqual(new Date('2026-10-20T12:02:20Z'));
    // Running from 12:00:00 to the last call's end; the idle minute is booked at the next use.
    expect(await used(a)).toEqual([['2026-10-01', 80]]);
  });
  it('stops counting a call whose end was lost at its deadline, so later calls pause the computer again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const opened = await open(a, 'claude');
    // A call whose done() never runs (its function was killed).
    const lost = await useComputerSession(db, computers, caller(a, 'claude'), opened.sessionId);
    if ('error' in lost) throw new Error(lost.error);
    // Within its deadline (12:01:40) it still counts.
    at('2026-10-20T12:00:30Z');
    await use(a, opened.sessionId, 'claude');
    expect(fake.calls.setTimeouts.at(-1)).toBe(130_000);
    at('2026-10-20T12:05:00Z');
    await use(a, opened.sessionId, 'claude');
    expect(fake.calls.setTimeouts.at(-1)).toBe(60_000);
    expect((await computerRow()).runsUntil).toEqual(new Date('2026-10-20T12:06:00Z'));
    expect((await computerRow()).callsInFlight).toEqual({});
    expect(await sessionRow(opened.sessionId)).toMatchObject({ lastCallAt: new Date('2026-10-20T12:05:00Z') });
    at('2026-10-20T12:06:01Z');
    expect(await open(a, 'chatgpt', undefined, opened.computer.id)).toHaveProperty('sessionId');
  });
  it('books a call that outlives its budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const opened = await open(a);
    at('2026-10-20T12:05:00Z');
    const call = await useComputerSession(db, computers, caller(a), opened.sessionId);
    if ('error' in call) throw new Error(call.error);
    at('2026-10-20T12:06:50Z');
    await call.done();
    expect((await computerRow()).runsUntil).toEqual(new Date('2026-10-20T12:07:50Z'));
    // The open's idle minute, then the call's 110s, past its 100s budget.
    expect(await used(a)).toEqual([['2026-10-01', 170]]);
  });
  it('books running time to the month it is metered in', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-31T23:59:30Z');
    const a = await user('a');
    const opened = await openComputerSession(db, computers, caller(a));
    if ('error' in opened) throw new Error(opened.error);
    at('2026-11-01T00:00:10Z');
    await opened.done();
    expect(await used(a)).toEqual([['2026-11-01', 40]]);
  });
  it('keeps the longer pause when the provider does not take the shorter timeout', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.failSetTimeout();
    const opened = await open(a);
    expect((await computerRow()).runsUntil).toEqual(new Date('2026-10-20T12:02:40Z'));
    expect(await sessionRow(opened.sessionId)).toMatchObject({ lastCallAt: new Date('2026-10-20T12:00:00Z') });
    // So the next use books the whole hold as running.
    at('2026-10-20T12:05:00Z');
    await use(a, opened.sessionId);
    expect(await used(a)).toEqual([['2026-10-01', 160]]);
  });
});

describe('computer_close', () => {
  it('pauses the fork with its work kept, ends the session, and books the time it ran', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const opened = await open(a, 'claude');
    sandbox().tabs = ['https://a.example.com/', 'https://b.example.com/'];
    await saveCapture(db, a, bundle([cookie()]));
    at('2026-10-20T12:00:20Z');
    expect(await closeComputerSession(db, computers, caller(a, 'chatgpt'), opened.sessionId)).toMatchObject({
      error: 'session_not_found',
    });
    expect(await closeComputerSession(db, computers, caller(a, 'claude'), opened.sessionId)).toEqual({ closed: true });
    // Nothing is applied or closed: the next open applies, and the agent comes back to its tabs.
    expect(sandbox()).toMatchObject({ paused: true, tabs: ['https://a.example.com/', 'https://b.example.com/'] });
    expect(fake.calls.sync).toBe(0);
    expect(await used(a)).toEqual([['2026-10-01', 20]]);
    expect((await computerRow()).runsUntil).toEqual(new Date('2026-10-20T12:00:20Z'));
    expect(await sessionRow(opened.sessionId)).toMatchObject({ endReason: 'closed' });
    for (const action of [useComputerSession, closeComputerSession])
      expect(await action(db, computers, caller(a, 'claude'), opened.sessionId)).toMatchObject({
        error: 'session_ended',
      });
    // The next open of the fork resumes it.
    await open(a, 'chatgpt', undefined, opened.computer.id);
    expect(sandbox()).toMatchObject({ paused: false });
    expect(fake.calls.sync).toBe(1);
  });
  it('leaves a call already in flight running, then lets it pause the computer and bills it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const opened = await open(a);
    at('2026-10-20T12:00:10Z');
    const call = await useComputerSession(db, computers, caller(a), opened.sessionId);
    if ('error' in call) throw new Error(call.error);
    at('2026-10-20T12:00:20Z');
    expect(await closeComputerSession(db, computers, caller(a), opened.sessionId)).toEqual({ closed: true });
    // The call's deadline (12:01:50) plus the idle minute, instead of a pause under the call; main paused at its snapshot.
    expect({ pause: fake.calls.pause, timeout: fake.calls.providerTimeouts.at(-1) }).toEqual({
      pause: 1,
      timeout: 150_000,
    });
    at('2026-10-20T12:00:40Z');
    await call.done();
    expect(fake.calls.setTimeouts.at(-1)).toBe(60_000);
    expect((await computerRow()).runsUntil).toEqual(new Date('2026-10-20T12:01:40Z'));
    // Running from 12:00:00 to the call's end.
    expect(await used(a)).toEqual([['2026-10-01', 40]]);
  });
  it('does not wake a fork that already paused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const opened = await open(a);
    at('2026-10-20T12:02:00Z');
    const before = { ...fake.calls, timeouts: fake.calls.timeouts.length };
    expect(await closeComputerSession(db, computers, caller(a), opened.sessionId)).toEqual({ closed: true });
    expect({ ...fake.calls, timeouts: fake.calls.timeouts.length }).toEqual(before);
    // The idle minute the computer ran is booked when it is next woken.
    expect(await used(a)).toEqual([]);
    expect(await sessionRow(opened.sessionId)).toMatchObject({ endReason: 'closed' });
  });
});

describe('apply on open', () => {
  // Each open passes the previous session_id, as one agent reopening its fork to apply.
  let last: string | undefined;
  const reopen = async (member: Member) => {
    const opened = await open(member, 'client', last);
    last = opened.sessionId;
    return opened;
  };
  beforeEach(() => {
    last = undefined;
  });
  const jar = () =>
    sandbox()
      .cookies.map(entry => `${entry.domain ?? new URL(entry.url!).hostname}:${entry.name}=${entry.value}`)
      .sort();
  const computerCookie = (name: string, value: string, host = 'example.com') => ({
    name,
    value,
    url: `https://${host}/`,
    path: '/',
    secure: true,
    httpOnly: true,
  });
  it('applies a new capture once, keeps agent-only sites, and clears sites signed out locally', async () => {
    const a = await user('a');
    expect((await reopen(a)).sync).toEqual({ status: 'none' });
    // Computer-origin state: a site only agents used, and a stale cookie for a site the capture holds.
    sandbox().cookies.push(
      { name: 'sid', value: 'computer', domain: '.google.com', path: '/', secure: true, httpOnly: true },
      computerCookie('tmp', 'agent', 'agent.dev'),
    );
    await saveCapture(
      db,
      a,
      bundle(
        [
          cookie(),
          cookie({ name: 'gh', domain: '.github.com', hostOnly: false }),
          cookie({ domain: 'mail.google.com' }),
        ],
        new Date('2026-10-15T10:00:00Z'),
      ),
    );
    // No baseline yet: each target site is replaced wholesale.
    expect((await reopen(a)).sync).toEqual({
      status: 'applied',
      captureCompletedAt: '2026-10-15T10:00:00.000Z',
      sitesUpdated: 3,
    });
    expect(jar()).toEqual([
      '.github.com:gh=local',
      'agent.dev:tmp=agent',
      'example.com:sid=local',
      'mail.google.com:sid=local',
    ]);
    expect(await computerRow()).toMatchObject({ appliedCaptureAt: new Date('2026-10-15T10:00:00Z') });
    expect((await computerRow()).syncedSites).toEqual(['example.com', 'github.com', 'google.com']);
    expect((await computerRow()).appliedCapture).not.toMatch(/local|example/);
    // Unchanged capture: no provider work.
    expect((await reopen(a)).sync).toEqual({ status: 'unchanged', captureCompletedAt: '2026-10-15T10:00:00.000Z' });
    expect(fake.calls.sync).toBe(1);
    // Signed out of GitHub and Gmail locally, example.com refreshed.
    await saveCapture(db, a, bundle([cookie({ value: 'fresh' })], new Date('2026-10-15T11:00:00Z')));
    expect((await reopen(a)).sync).toMatchObject({ status: 'applied', sitesUpdated: 3 });
    expect(jar()).toEqual(['agent.dev:tmp=agent', 'example.com:sid=fresh']);
    expect((await computerRow()).syncedSites).toEqual(['example.com']);
  });
  it('sets only what the host changed: the host wins its changes, the computer keeps the rest', async () => {
    const a = await user('a');
    await saveCapture(
      db,
      a,
      bundle([
        cookie({ name: 'changed', value: '1' }),
        cookie({ name: 'kept', value: '1' }),
        cookie({ name: 'deleted', value: '1' }),
        cookie({ name: 'gh', domain: 'github.com' }),
      ]),
    );
    await reopen(a);
    // The computer rotates two cookies and sets one of its own on the synced site.
    const own = ['changed', 'kept', 'own'];
    sandbox().cookies = [
      ...sandbox().cookies.filter(entry => !own.includes(entry.name)),
      ...own.map(name => computerCookie(name, 'computer')),
    ];
    await saveCapture(
      db,
      a,
      bundle([
        cookie({ name: 'changed', value: '2' }),
        cookie({ name: 'kept', value: '1' }),
        cookie({ name: 'added', value: '1' }),
      ]),
    );
    expect((await reopen(a)).sync).toMatchObject({ status: 'applied', sitesUpdated: 2 });
    expect(jar()).toEqual([
      'example.com:added=1',
      'example.com:changed=2',
      'example.com:kept=computer',
      'example.com:own=computer',
    ]);
    // A legacy row (or one after Delete everything) has no baseline: the next apply is wholesale again.
    await db.update(schema.computers).set({ appliedCapture: null });
    await saveCapture(db, a, bundle([cookie({ name: 'kept', value: '1' })]));
    expect((await reopen(a)).sync).toMatchObject({ status: 'applied', sitesUpdated: 1 });
    expect(jar()).toEqual(['example.com:kept=1']);
  });
  it('starts a fork with what main had applied, so its first apply sends only what changed since', async () => {
    const a = await user('a');
    await saveCapture(
      db,
      a,
      bundle([cookie({ name: 'kept', value: '1' }), cookie({ name: 'gh', domain: 'github.com' })]),
    );
    // The member's takeover applies the capture on main, and its end snapshots it.
    const page = randomUUID();
    await takeOverComputer(db, computers, a, page);
    await handBackComputer(db, computers, a, page);
    expect(fake.calls.sync).toBe(1);
    const unchanged = await open(a);
    expect(unchanged.sync).toMatchObject({ status: 'unchanged' });
    expect(fake.calls.sync).toBe(1);
    expect((await forkRow(unchanged.computer.id)).appliedCapture).not.toBe((await mainRow()).appliedCapture);
    // A newer capture: the fork gets only the changed site, and keeps what main rotated on the other.
    (await mainSandbox()).cookies.push(computerCookie('rotated', 'main', 'github.com'));
    await saveCapture(
      db,
      a,
      bundle([cookie({ name: 'kept', value: '2' }), cookie({ name: 'gh', domain: 'github.com' })]),
    );
    await db.update(schema.computers).set({ snapshotDueAt: new Date() }).where(isNull(schema.computers.forkOf));
    const changed = await open(a);
    expect(changed.sync).toMatchObject({ status: 'applied', sitesUpdated: 1 });
    expect(jar()).toEqual(['example.com:kept=2', 'github.com:gh=local', 'github.com:rotated=main']);
  });
  it('never applies within a computer session; the next open of the fork does', async () => {
    const a = await user('a');
    await saveCapture(db, a, bundle([cookie()]));
    await reopen(a);
    await saveCapture(db, a, bundle([cookie({ value: 'rotated' }), cookie({ name: 'new', domain: 'notion.so' })]));
    expect(await use(a, last!)).not.toHaveProperty('pending');
    expect(fake.calls.sync).toBe(1);
    expect(jar()).toEqual(['example.com:sid=local']);
    expect((await reopen(a)).sync).toMatchObject({ status: 'applied', sitesUpdated: 2 });
    expect(jar()).toEqual(['example.com:sid=rotated', 'notion.so:new=local']);
  });
  it('still opens when apply fails and retries on the next open', async () => {
    const a = await user('a');
    await saveCapture(db, a, bundle([cookie()], new Date('2026-10-15T10:00:00Z')));
    fake.failSync();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await reopen(a);
    expect(failed.sync).toEqual({ status: 'failed', captureCompletedAt: '2026-10-15T10:00:00.000Z' });
    expect(error.mock.calls.flat().join(' ')).not.toMatch(/local|example\.com/);
    expect(await computerRow()).toMatchObject({ appliedCaptureDigest: null, appliedCaptureAt: null });
    fake.failSync(false);
    expect((await reopen(a)).sync).toMatchObject({ status: 'applied', sitesUpdated: 1 });
    expect(jar()).toEqual(['example.com:sid=local']);
  });
  it("sets the computer to the user's time zone on open, only when it changed, and retries a failure", async () => {
    const a = await user('a');
    await reopen(a);
    expect(fake.calls.timeZones).toEqual([]);
    await setTimeZone(db, a.userId, 'America/Los_Angeles');
    fake.failTimeZone();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await reopen(a)).sync).toEqual({ status: 'none' });
    expect(error).toHaveBeenCalled();
    expect((await computerRow()).timeZone).toBeNull();
    fake.failTimeZone(false);
    await reopen(a);
    expect(sandbox().timeZone).toBe('America/Los_Angeles');
    expect((await computerRow()).timeZone).toBe('America/Los_Angeles');
    await reopen(a);
    expect(fake.calls.timeZones).toEqual(['America/Los_Angeles', 'America/Los_Angeles']);
    await setTimeZone(db, a.userId, 'Europe/London');
    await reopen(a);
    expect(sandbox().timeZone).toBe('Europe/London');
  });
  it('brings a computer behind the provider revision current on open, before the apply, and retries a failure', async () => {
    const a = await user('a');
    await saveCapture(db, a, bundle([cookie()]));
    await reopen(a);
    // A new fork of a current main is only checked, once.
    expect((await computerRow()).revision).toBe('revision-1');
    await reopen(a);
    expect(fake.calls.steps).toEqual(['refresh', 'sync']);
    fake.setRevision('revision-2');
    fake.failRefresh();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await saveCapture(db, a, bundle([cookie({ value: 'new' })]));
    expect((await reopen(a)).sync).toMatchObject({ status: 'applied' });
    expect(error).toHaveBeenCalled();
    expect((await computerRow()).revision).toBe('revision-1');
    fake.failRefresh(false);
    sandbox().tabs.push('https://example.com/');
    await reopen(a);
    expect(sandbox()).toMatchObject({ revision: 'revision-2', tabs: ['about:blank'] });
    expect(jar()).toEqual(['example.com:sid=new']);
    expect((await computerRow()).revision).toBe('revision-2');
    // Closing never refreshes; only opens do, before control is handed over.
    await closeComputerSession(db, computers, caller(a), last!);
    expect(fake.calls.steps).toEqual(['refresh', 'sync', 'refresh', 'sync', 'refresh']);
  });
  it('re-applies a re-upload wholesale after captures are deleted', async () => {
    const a = await user('a');
    const capture = bundle([cookie()]);
    await saveCapture(db, a, capture);
    await reopen(a);
    await deleteCaptures(db, a);
    expect(await computerRow()).toMatchObject({ appliedCaptureDigest: null, appliedCapture: null });
    expect((await reopen(a)).sync).toEqual({ status: 'none' });
    await saveCapture(db, a, capture);
    expect((await reopen(a)).sync).toMatchObject({ status: 'applied' });
    expect(fake.calls.sync).toBe(2);
  });
  it('does not overwrite a concurrent apply of another capture, and re-applies wholesale next time', async () => {
    const a = await user('a');
    const first = await reopen(a);
    await saveCapture(db, a, bundle([cookie()]));
    // Another open racing this one applies a different capture while this one runs.
    const connect = fake.provider.connect;
    fake.provider.connect = async (sandboxId, timeoutMs) => {
      const session = await connect(sandboxId, timeoutMs);
      return {
        ...session,
        syncCookies: async input => {
          await db
            .update(schema.computers)
            .set({ appliedCaptureDigest: 'other', syncedSites: ['other.test'] })
            .where(eq(schema.computers.publicId, first.computer.id));
          return session.syncCookies(input);
        },
      };
    };
    expect((await reopen(a)).sync).toMatchObject({ status: 'applied' });
    expect(await computerRow()).toMatchObject({ appliedCaptureDigest: null, appliedCapture: null });
    expect((await computerRow()).syncedSites.sort()).toEqual(['example.com', 'other.test']);
    fake.provider.connect = connect;
    expect((await reopen(a)).sync).toMatchObject({ status: 'applied', sitesUpdated: 2 });
    expect((await computerRow()).syncedSites).toEqual(['example.com']);
  });
  it('skips the apply when the open has no time left, without failing the open', async () => {
    const a = await user('a');
    await reopen(a);
    await saveCapture(db, a, bundle([cookie()]));
    const now = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now() + skew);
    const connect = fake.provider.connect;
    fake.provider.connect = async (sandboxId, timeoutMs) => {
      skew = 70_000;
      return connect(sandboxId, timeoutMs);
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await reopen(a)).sync).toMatchObject({ status: 'failed' });
      expect(fake.calls.sync).toBe(0);
    } finally {
      vi.restoreAllMocks();
      fake.provider.connect = connect;
    }
  });
  it('gives the provider its budget, so a sync cut short never changes cookies after the open returns', async () => {
    const a = await user('a');
    await reopen(a);
    await saveCapture(db, a, bundle([cookie()]));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fake.slowSync(50_000);
      let returned = false;
      const opening = reopen(a).finally(() => {
        returned = true;
      });
      await vi.waitFor(() => expect(fake.calls.sync).toBe(1));
      while (!returned) await vi.advanceTimersByTimeAsync(1_000);
      expect((await opening).sync).toMatchObject({ status: 'failed' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(jar()).toEqual([]);
      expect(await computerRow()).toMatchObject({ appliedCaptureDigest: null, appliedCapture: null });
      expect(fake.calls.syncBudgets[0]).toBeLessThanOrEqual(45_000);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});

describe('metering', () => {
  const usedUp: MeteringRefusal = { message: 'Used up.', resetsAt: new Date('2026-11-01T00:00:00Z') };
  it('refuses to create, wake, or use a computer while metering refuses, and books nothing for refusals', async () => {
    const a = await user('a');
    const b = await user('b');
    const opened = await open(a);
    const booked = await used(a);
    refusal = usedUp;
    expect(await useComputerSession(db, computers, caller(a), opened.sessionId)).toEqual({
      error: 'allowance_exhausted',
      ...usedUp,
    });
    expect(await openComputerSession(db, computers, caller(a, 'chatgpt'))).toMatchObject({
      error: 'allowance_exhausted',
    });
    expect(
      await openComputerSession(db, computers, caller(a, 'chatgpt'), { computerId: opened.computer.id }),
    ).toMatchObject({ error: 'allowance_exhausted' });
    expect(await openComputerSession(db, computers, caller(b))).toMatchObject({ error: 'allowance_exhausted' });
    expect({ create: fake.calls.create, fork: fake.calls.fork }).toEqual({ create: 1, fork: 1 });
    expect(await used(a)).toEqual(booked);
    refusal = null;
    expect(await use(a, opened.sessionId)).not.toHaveProperty('error');
  });
  it('runs with no allowance under the default hooks', async () => {
    const a = await user('a');
    const defaults = { provider: fake.provider, metering: noMetering };
    const opened = await openComputerSession(db, defaults, caller(a));
    if ('error' in opened) throw new Error(opened.error);
    await opened.done();
    expect(await closeComputerSession(db, defaults, caller(a), opened.sessionId)).toEqual({ closed: true });
    expect((await computerView(db, noMetering, a)).usage).toBeNull();
    expect(await liveViewStatus(db, noMetering, a, randomUUID())).not.toHaveProperty('allowanceExhausted');
  });
});

describe('live view', () => {
  const lease = () => randomUUID();
  const beat = (member: Member, id: string, state: 'visible' | 'hidden' | 'released', target = {}) =>
    liveViewHeartbeat(db, computers, member, { id, state }, new Date(), target);
  const takeOver = async (member: Member, id: string, target = {}) => {
    const status = await takeOverComputer(db, computers, member, id, target);
    if ('error' in status) throw new Error(status.error);
    return status;
  };
  it('suspends the agent for a takeover of its fork, and resumes it with its idle clock shifted and no apply', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const claudeCode = 'https://claude.ai/oauth/claude-code-client-metadata';
    await db.insert(schema.oauthClient).values({ id: randomUUID(), clientId: claudeCode, redirectUris: [] });
    const agent = await open(a, claudeCode);
    const fork = { computerId: agent.computer.id };
    await saveCapture(db, a, bundle([cookie()]));
    const page = lease();
    at('2026-10-20T12:00:20Z');
    expect(await takeOver(a, page, fork)).toEqual({
      computer: 'running',
      watching: true,
      takeover: { mine: true, since: '2026-10-20T12:00:20.000Z' },
      agentWaiting: null,
    });
    // Nothing is applied under the agent's session.
    expect(fake.calls.sync).toBe(0);
    expect(await sessionRow(agent.sessionId)).toMatchObject({ suspendedAt: new Date('2026-10-20T12:00:20Z') });
    expect(await liveViewAccess(db, a, page, undefined, fork)).toBe('control');
    expect(await liveViewAccess(db, a, lease(), undefined, fork)).toBe('none');
    // The main computer is not taken over.
    expect(await liveViewAccess(db, a, page)).toBe('none');
    expect((await computerView(db, metering, a)).computer).toMatchObject({ inLiveView: false });
    at('2026-10-20T12:00:30Z');
    const waiting = await useComputerSession(db, computers, caller(a, claudeCode), agent.sessionId);
    expect(waiting).toMatchObject({ error: 'user_in_control' });
    expect(waiting).not.toHaveProperty('busyUntil');
    expect(
      await openComputerSession(db, computers, caller(a, claudeCode), { sessionId: agent.sessionId }),
    ).toMatchObject({ error: 'user_in_control' });
    const busy = await openComputerSession(db, computers, caller(a, 'chatgpt'), fork);
    expect(busy).toMatchObject({ error: 'busy' });
    expect(busy).not.toHaveProperty('busyUntil');
    expect(await listForks(db, a)).toEqual([expect.objectContaining({ status: 'in_use' })]);
    // The MCP layer records the agent's user_in_control call; the page names the waiting agent from it.
    const { id: sessionKey } = await sessionRow(agent.sessionId);
    await db.insert(schema.toolCalls).values({
      membershipId: a.membershipId,
      clientId: claudeCode,
      computerSessionId: sessionKey,
      tool: 'computer_screenshot',
      startedAt: new Date(),
      endedAt: new Date(),
      error: 'user_in_control',
    });
    expect((await liveViewStatus(db, metering, a, page, undefined, fork)).agentWaiting).toEqual({
      agent: 'claude-code',
      host: 'claude.ai',
      since: '2026-10-20T12:00:30.000Z',
    });
    // Another page of the user's sees the takeover as not its own.
    expect((await liveViewStatus(db, metering, a, lease(), undefined, fork)).takeover).toEqual({
      mine: false,
      since: '2026-10-20T12:00:20.000Z',
    });
    at('2026-10-20T12:01:00Z');
    expect(await handBackComputer(db, computers, a, page, fork)).toMatchObject({
      takeover: null,
      agentWaiting: null,
      watching: true,
    });
    // Idle 20 s when suspended, so 20 s at the hand-back.
    expect(await sessionRow(agent.sessionId)).toMatchObject({
      suspendedAt: null,
      handedBackAt: new Date('2026-10-20T12:01:00Z'),
      lastCallAt: new Date('2026-10-20T12:00:40Z'),
    });
    expect(await openComputerSession(db, computers, caller(a, 'chatgpt'), fork)).toMatchObject({
      error: 'busy',
      busyUntil: new Date('2026-10-20T12:01:40Z'),
    });
    expect(await use(a, agent.sessionId, claudeCode)).toMatchObject({ userHadControl: true });
    expect(await use(a, agent.sessionId, claudeCode)).not.toHaveProperty('userHadControl');
    expect(fake.calls.sync).toBe(0);
    // A fork's takeover is not a sign-in on main: nothing new to snapshot.
    expect(fake.calls.snapshot).toBe(1);
    expect(await liveViewAccess(db, a, page, undefined, fork)).toBe('view');
  });
  it('ends a lapsed takeover lazily, resuming the session as of the lapse', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const agent = await open(a, 'claude');
    const fork = { computerId: agent.computer.id };
    const page = lease();
    at('2026-10-20T12:00:10Z');
    await takeOver(a, page, fork);
    expect(await computerRow()).toMatchObject({ takeoverUntil: new Date('2026-10-20T12:01:25Z') });
    // Past the lapse, readers treat it as ended before anything writes.
    at('2026-10-20T12:01:25Z');
    expect(await liveViewStatus(db, metering, a, page, undefined, fork)).toMatchObject({
      takeover: null,
      watching: false,
    });
    expect(await liveViewAccess(db, a, page, undefined, fork)).toBe('none');
    at('2026-10-20T12:03:00Z');
    expect(await use(a, agent.sessionId, 'claude')).toMatchObject({ userHadControl: true });
    expect(await computerRow()).toMatchObject({ takeoverLease: null, takenOverAt: null, takeoverUntil: null });
    // Suspended 10 s after its last call; resumed at the lapse (12:01:25), then the 12:03:00 call ran.
    expect(await sessionRow(agent.sessionId)).toMatchObject({
      handedBackAt: null,
      lastCallAt: new Date('2026-10-20T12:03:00Z'),
    });
  });
  it('treats a takeover with no agent working like computer_open, without marking setup', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    await saveCapture(db, a, bundle([cookie()]));
    await setTimeZone(db, a.userId, 'Europe/London');
    const page = lease();
    // Creates the main computer, then applies the capture and time zone.
    expect(await takeOver(a, page)).toMatchObject({ computer: 'running', takeover: { mine: true } });
    expect(fake.calls.create).toBe(1);
    expect(fake.calls.sync).toBe(1);
    expect(sandbox()).toMatchObject({ timeZone: 'Europe/London' });
    expect(sandbox().cookies.map(entry => entry.name)).toEqual(['sid']);
    expect(await db.select().from(schema.setups)).toEqual([]);
    at('2026-10-20T12:00:30Z');
    await handBackComputer(db, computers, a, page);
    const agent = await open(a, 'claude');
    const fork = { computerId: agent.computer.id };
    // An agent idle past its minute, but not ended, is still working: the next takeover of its fork suspends it, no apply.
    at('2026-10-20T12:05:00Z');
    await saveCapture(db, a, bundle([cookie({ value: 'new' })]));
    await takeOver(a, page, fork);
    expect(fake.calls.sync).toBe(1);
    expect(await sessionRow(agent.sessionId)).toMatchObject({ suspendedAt: new Date('2026-10-20T12:05:00Z') });
    // An agent idle 10 minutes is over: it ends, and the takeover applies.
    at('2026-10-20T12:05:10Z');
    await handBackComputer(db, computers, a, page, fork);
    at('2026-10-20T12:16:00Z');
    await takeOver(a, page, fork);
    expect(await sessionRow(agent.sessionId)).toMatchObject({ endReason: 'idle' });
    expect(fake.calls.sync).toBe(2);
  });
  it('runs a takeover to its lapse, extends it every few beats, and meters it until the release pauses it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const page = lease();
    await takeOver(a, page);
    // The create's idle minute, then to the takeover's lapse at 12:01:15.
    expect(fake.calls.timeouts).toEqual([60_000, 75_000]);
    expect(await used(a)).toEqual([]);
    at('2026-10-20T12:00:10Z');
    await beat(a, page, 'visible');
    // More than the lapse left: nothing written, metered, or connected.
    expect(fake.calls.timeouts).toHaveLength(2);
    expect(await used(a)).toEqual([]);
    at('2026-10-20T12:00:20Z');
    expect(await beat(a, page, 'visible')).toMatchObject({ takeover: { mine: true }, watching: true });
    expect(await computerRow()).toMatchObject({ takeoverUntil: new Date('2026-10-20T12:01:35Z') });
    expect(fake.calls.timeouts).toEqual([60_000, 75_000, 75_000]);
    expect(await used(a)).toEqual([['2026-10-01', 20]]);
    // Hand-back keeps the page watching, so the computer runs to the watch's lapse, and snapshots it for new forks.
    at('2026-10-20T12:00:30Z');
    await handBackComputer(db, computers, a, page);
    expect({ pause: fake.calls.pause, snapshot: fake.calls.snapshot, timeouts: fake.calls.providerTimeouts }).toEqual({
      pause: 0,
      snapshot: 1,
      timeouts: [65_000, 65_000],
    });
    expect((await computerRow()).runsUntil).toEqual(new Date('2026-10-20T12:01:35Z'));
    // Leaving the page pauses the computer at once, which books its running time.
    at('2026-10-20T12:00:40Z');
    expect(await beat(a, page, 'released')).toMatchObject({ computer: 'paused', watching: false, takeover: null });
    expect(fake.calls.pause).toBe(1);
    expect(sandbox()).toMatchObject({ paused: true });
    expect(await used(a)).toEqual([['2026-10-01', 40]]);
  });
  it('wakes a paused fork for a watch, keeps it running past an agent close, and lapses a hidden page', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const page = lease();
    const agent = await open(a);
    const fork = { computerId: agent.computer.id };
    await closeComputerSession(db, computers, caller(a), agent.sessionId);
    expect(sandbox()).toMatchObject({ paused: true });
    at('2026-10-20T12:00:10Z');
    expect(await beat(a, page, 'visible', fork)).toMatchObject({ computer: 'running', watching: true });
    expect(sandbox()).toMatchObject({ paused: false });
    expect((await computerRow()).runsUntil).toEqual(new Date('2026-10-20T12:01:25Z'));
    // The 10 seconds paused are not booked.
    expect(await used(a)).toEqual([]);
    // The relay connects for the watch, asking the provider to run the computer to the watch's lapse.
    expect(await connectLiveView(db, fake.provider, a, page, fork)).toHaveProperty('isPrivate', true);
    expect(fake.calls.timeouts.at(-1)).toBe(75_000);
    // Watching is not a session boundary: an agent reopens as usual, and its close leaves the fork running.
    const next = await open(a, 'claude', undefined, agent.computer.id);
    at('2026-10-20T12:00:20Z');
    const pauses = fake.calls.pause;
    await closeComputerSession(db, computers, caller(a, 'claude'), next.sessionId);
    expect(fake.calls.pause).toBe(pauses);
    expect(fake.calls.providerTimeouts.at(-1)).toBe(65_000);
    expect((await computerRow()).runsUntil).toEqual(new Date('2026-10-20T12:01:25Z'));
    expect(await used(a)).toEqual([['2026-10-01', 10]]);
    // Hidden: the watch lapses a minute from now instead, and the provider follows.
    at('2026-10-20T12:00:30Z');
    await beat(a, page, 'visible', fork);
    expect((await computerRow()).runsUntil).toEqual(new Date('2026-10-20T12:01:45Z'));
    at('2026-10-20T12:00:35Z');
    expect(await beat(a, page, 'hidden', fork)).toMatchObject({ watching: true });
    expect(fake.calls.providerTimeouts.at(-1)).toBe(60_000);
    expect((await computerRow()).runsUntil).toEqual(new Date('2026-10-20T12:01:35Z'));
    at('2026-10-20T12:01:35Z');
    expect(await beat(a, page, 'hidden', fork)).toMatchObject({ watching: false });
    // A watch of a fork never creates one.
    expect(await beat(a, lease(), 'visible', { computerId: newPublicId('computer') })).toMatchObject({
      computer: 'none',
    });
  });
  it("keeps each page's watch, moves a takeover to the latest page, and ignores another page's release", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const b = await user('b');
    const [first, second] = [lease(), lease()];
    await takeOver(a, first);
    await beat(a, second, 'visible');
    at('2026-10-20T12:00:10Z');
    expect(await takeOver(a, second)).toMatchObject({ takeover: { mine: true, since: '2026-10-20T12:00:00.000Z' } });
    expect(await liveViewAccess(db, a, first)).toBe('view');
    expect(await liveViewAccess(db, a, second)).toBe('control');
    // Another user's lease never controls or reaches this computer.
    expect(await liveViewAccess(db, b, second)).toBe('none');
    expect(await handBackComputer(db, computers, a, first)).toMatchObject({ takeover: { mine: false } });
    expect(await beat(a, first, 'released')).toMatchObject({ watching: false, takeover: { mine: false } });
    expect(await liveViewAccess(db, a, second)).toBe('control');
    // The second page's takeover still holds the computer to 12:01:25.
    expect({ pause: fake.calls.pause, timeouts: fake.calls.providerTimeouts }).toEqual({
      pause: 0,
      timeouts: [75_000],
    });
    expect(await beat(a, second, 'released')).toMatchObject({ watching: false, takeover: null });
    expect(fake.calls.pause).toBe(1);
    // A release ends the takeover without a snapshot; the next fork takes it.
    expect(fake.calls.snapshot).toBe(0);
    expect((await mainRow()).snapshotDueAt).not.toBeNull();
  });
  it('lets an agent close its suspended session without touching the fork', async () => {
    const a = await user('a');
    const agent = await open(a, 'claude');
    const fork = { computerId: agent.computer.id };
    const page = lease();
    await takeOver(a, page, fork);
    const before = { ...fake.calls, timeouts: fake.calls.timeouts.length };
    expect(await closeComputerSession(db, computers, caller(a, 'claude'), agent.sessionId)).toEqual({ closed: true });
    expect(await sessionRow(agent.sessionId)).toMatchObject({ endReason: 'closed' });
    expect({ ...fake.calls, timeouts: fake.calls.timeouts.length }).toEqual(before);
    expect(await liveViewAccess(db, a, page, undefined, fork)).toBe('control');
  });
  it('refuses a takeover and stops extending holds once metering refuses, so they lapse', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const page = lease();
    await takeOver(a, page);
    refusal = { message: 'Used up.', resetsAt: new Date('2026-11-01T00:00:00Z') };
    expect(await takeOverComputer(db, computers, a, lease())).toMatchObject({
      error: 'allowance_exhausted',
      resetsAt: new Date('2026-11-01T00:00:00Z'),
    });
    at('2026-10-20T12:00:30Z');
    expect(await beat(a, page, 'visible')).toMatchObject({
      takeover: { mine: true },
      allowanceExhausted: { resetsAt: '2026-11-01T00:00:00.000Z' },
    });
    expect(await computerRow()).toMatchObject({ takeoverUntil: new Date('2026-10-20T12:01:15Z') });
    at('2026-10-20T12:01:15Z');
    expect(await beat(a, page, 'visible')).toMatchObject({ takeover: null, watching: false });
    expect(await computerRow()).toMatchObject({ takeoverLease: null });
  });
  it('creates the main computer for a watch with the latest capture, without marking the user set up', async () => {
    const a = await user('a');
    await saveCapture(db, a, bundle([cookie()]));
    const page = lease();
    expect(await beat(a, page, 'visible')).toEqual({
      computer: 'running',
      watching: true,
      takeover: null,
      agentWaiting: null,
    });
    expect(fake.calls.create).toBe(1);
    expect(fake.calls.sync).toBe(1);
    expect(await db.select().from(schema.setups)).toEqual([]);
    // Later beats watch the same computer and apply nothing more.
    expect(await beat(a, page, 'visible')).toMatchObject({ computer: 'running', watching: true });
    expect(fake.calls).toMatchObject({ create: 1, sync: 1 });
    // A metering refusal creates nothing.
    const b = await user('b');
    refusal = { message: 'Used up.', resetsAt: new Date('2026-11-01T00:00:00Z') };
    expect(await beat(b, lease(), 'visible')).toMatchObject({ computer: 'none', watching: false });
    expect(fake.calls.create).toBe(1);
  });
  it('ends every hold and fork with the computer when it is reset during a takeover', async () => {
    const a = await user('a');
    const agent = await open(a, 'claude');
    const page = lease();
    await takeOver(a, page);
    await deleteMainComputer(db, fake.provider, a);
    expect(await liveViewAccess(db, a, page)).toBe('none');
    expect(await beat(a, page, 'released')).toMatchObject({ computer: 'none', takeover: null });
    expect(await use(a, agent.sessionId, 'claude')).toMatchObject({ error: 'session_not_found' });
    expect(await takeOver(a, page)).toMatchObject({ computer: 'running', takeover: { mine: true } });
    expect(fake.calls.create).toBe(2);
  });
  it('keeps the hand-back notice until a call after it can run, and gives it to a reopen of the same session', async () => {
    const a = await user('a');
    const agent = await open(a, 'claude');
    const fork = { computerId: agent.computer.id };
    const page = lease();
    await takeOver(a, page, fork);
    await handBackComputer(db, computers, a, page, fork);
    vi.spyOn(fake.provider, 'connect').mockRejectedValueOnce(new Error('unreachable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(use(a, agent.sessionId, 'claude')).rejects.toThrow('unreachable');
    expect(await sessionRow(agent.sessionId)).toMatchObject({ handedBackAt: expect.any(Date) });
    expect(await use(a, agent.sessionId, 'claude')).toMatchObject({ userHadControl: true });
    expect(await use(a, agent.sessionId, 'claude')).not.toHaveProperty('userHadControl');
    // Reopening with its session_id right after a hand-back says so too; reopening again does not.
    await takeOver(a, page, fork);
    await handBackComputer(db, computers, a, page, fork);
    const reopened = await open(a, 'claude', agent.sessionId);
    expect(reopened).toMatchObject({ userHadControl: true });
    expect(await open(a, 'claude', reopened.sessionId)).not.toHaveProperty('userHadControl');
  });
  it('ignores a visible beat for a lease its page just released, and caps the watches a user can hold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    await open(a);
    const page = lease();
    expect(await beat(a, page, 'visible')).toMatchObject({ watching: true });
    // The page closed: its release lands, then a visible beat it sent just before.
    at('2026-10-20T12:00:01Z');
    await beat(a, page, 'released');
    const connects = fake.calls.timeouts.length;
    expect(await beat(a, page, 'visible')).toMatchObject({ watching: false });
    expect(fake.calls.timeouts).toHaveLength(connects);
    // A lease released before it ever watched is remembered too (a page that left at once).
    const gone = lease();
    await beat(a, gone, 'released');
    expect(await beat(a, gone, 'visible')).toMatchObject({ watching: false });
    // Eight pages watch; a ninth does not, and adding the eighth at the same moment asked the provider for nothing.
    const pages = Array.from({ length: 8 }, lease);
    for (const id of pages.slice(0, 7)) expect(await beat(a, id, 'visible')).toMatchObject({ watching: true });
    const before = fake.calls.timeouts.length;
    expect(await beat(a, pages[7]!, 'visible')).toMatchObject({ watching: true });
    expect(fake.calls.timeouts).toHaveLength(before);
    expect(await beat(a, lease(), 'visible')).toMatchObject({ watching: false });
    // Releases are forgotten once no beat from before them could still arrive.
    at('2026-10-20T12:01:02Z');
    await beat(a, pages[0]!, 'visible');
    expect(Object.keys((await mainRow()).liveViewWatches).sort()).toEqual([...pages].sort());
  });
  it("sets the computer's clipboard only for the lease holding a live takeover, up to 1 MiB of UTF-8", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-20T12:00:00Z');
    const a = await user('a');
    const b = await user('b');
    const page = lease();
    const paste = (member: Member, id: string, text: string) =>
      setLiveViewClipboard(db, fake.provider, member, id, text);
    expect(await paste(a, page, 'x')).toBe('not_in_control');
    await beat(a, page, 'visible');
    // Watching is not control.
    expect(await paste(a, page, 'x')).toBe('not_in_control');
    await takeOver(a, page);
    const before = fake.calls.timeouts.length;
    expect(await paste(a, page, '日本語 🎉')).toBe('set');
    expect(sandbox().clipboard).toBe('日本語 🎉');
    // Connecting asks the provider for no more than the takeover already asked for.
    expect(fake.calls.timeouts.slice(before)).toEqual([(await computerRow()).takeoverUntil!.getTime() - Date.now()]);
    expect(await paste(a, lease(), 'other page')).toBe('not_in_control');
    expect(await paste(b, page, 'other user')).toBe('not_in_control');
    expect(await paste(a, page, '€'.repeat(Math.floor(MAX_CLIPBOARD_BYTES / 3) + 1))).toBe('too_large');
    expect(sandbox().clipboard).toBe('日本語 🎉');
    // A failure on the computer reaches the caller, which reports it.
    fake.failClipboard();
    await expect(paste(a, page, 'x')).rejects.toThrow('setClipboard failed');
    fake.failClipboard(false);
    // A lapsed takeover is no longer control.
    at('2026-10-20T12:05:00Z');
    expect(await paste(a, page, 'late')).toBe('not_in_control');
    expect(sandbox().clipboard).toBe('日本語 🎉');
  });
  it('refuses live view on a computer that accepts public traffic until it is reset', async () => {
    const a = await user('a');
    await open(a);
    (await mainSandbox()).public = true;
    const page = lease();
    expect(await takeOverComputer(db, computers, a, page)).toMatchObject({ error: 'needs_reset' });
    expect(await mainRow()).toMatchObject({ takeoverLease: null });
    await beat(a, page, 'visible');
    expect(await connectLiveView(db, fake.provider, a, page)).toBe('needs_reset');
    await deleteMainComputer(db, fake.provider, a);
    expect(await takeOver(a, page)).toMatchObject({ takeover: { mine: true } });
  });
  it('rolls the takeover back when the computer cannot be reached', async () => {
    const a = await user('a');
    const agent = await open(a, 'claude');
    const fork = { computerId: agent.computer.id };
    vi.spyOn(fake.provider, 'connect').mockRejectedValueOnce(new Error('unreachable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = lease();
    await expect(takeOverComputer(db, computers, a, page, fork)).rejects.toThrow('unreachable');
    expect(await liveViewAccess(db, a, page, undefined, fork)).toBe('none');
    expect(await sessionRow(agent.sessionId)).toMatchObject({ suspendedAt: null, endedAt: null });
  });
  it('runs each lease of a heartbeat through its kind and refuses unknown kinds', async () => {
    const a = await user('a');
    await open(a);
    const [first, second] = [lease(), lease()];
    expect(heartbeatSchema.safeParse({ leases: [{ kind: 'chat', id: first, state: 'visible' }] }).success).toBe(false);
    expect(heartbeatSchema.safeParse({ leases: [{ kind: 'live-view', id: 'x', state: 'visible' }] }).success).toBe(
      false,
    );
    const body = heartbeatSchema.parse({
      leases: [
        { kind: 'live-view', id: first, state: 'visible' },
        { kind: 'live-view', id: second, state: 'hidden' },
      ],
    });
    expect(await heartbeat(db, computers, a, body)).toEqual({
      leases: [
        { kind: 'live-view', id: first, status: expect.objectContaining({ watching: true }) },
        { kind: 'live-view', id: second, status: expect.objectContaining({ watching: false }) },
      ],
    });
  });
});
