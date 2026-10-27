import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Database } from './database';
import { databaseSchema } from './database-schema';
import { newPublicId } from './ids';
import { person } from './member-fixtures';
import * as schema from './schema';

// The profiles migration (0027) on data the release before it wrote: each member's capture moves to a browser, and each
// computer's and snapshot's applied state becomes that browser's first profile, in the directory Chrome already runs.
const migrations = fileURLToPath(new URL('../migrations', import.meta.url));
const PROFILES = '0027_profiles';
let pg: PGlite;
let db: Database;
let before: string;
beforeAll(async () => {
  // The migrations up to the one before, then this one's statements on what they left.
  before = mkdtempSync(join(tmpdir(), 'migrations-'));
  cpSync(migrations, before, { recursive: true });
  const journal = JSON.parse(readFileSync(join(before, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag !== PROFILES);
  writeFileSync(join(before, 'meta/_journal.json'), JSON.stringify(journal));
  rmSync(join(before, `${PROFILES}.sql`));
  pg = new PGlite();
  db = drizzle(pg, { schema: databaseSchema }) as unknown as Database;
  await migrate(drizzle(pg), { migrationsFolder: before });
});
afterAll(async () => {
  await pg.close();
  rmSync(before, { recursive: true, force: true });
});

it('keeps every computer signed in as its first profile, owned by the browser that synced it', async () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 26, 12, minute));
  const browser = async (
    membershipId: number,
    name: string,
    synced: Date | null,
    gone: Partial<Record<'removed' | 'signedOut', true>> = {},
  ) => {
    const [row] = await db
      .insert(schema.connectedBrowsers)
      .values({
        publicId: newPublicId('browser'),
        membershipId,
        authorizationCodeId: `${membershipId}-${name}`,
        lastSyncedAt: synced,
        disconnectedAt: gone.signedOut ? at(50) : null,
      })
      .returning({ id: schema.connectedBrowsers.id });
    await db.insert(schema.browserMemberships).values({
      connectedBrowserId: row!.id,
      membershipId,
      lastSyncedAt: synced,
      removedAt: gone.removed ? at(50) : null,
    });
    return row!.id;
  };
  const capture = (membershipId: number, sender: number | null) =>
    db.insert(schema.captures).values({
      membershipId,
      captureId: crypto.randomUUID(),
      digest: `digest-${membershipId}`,
      cookieCount: 1,
      sealed: `sealed-${membershipId}`,
      sealedScope: `scope-${membershipId}`,
      completedAt: at(10),
      uploadedAt: at(11),
      connectedBrowserId: sender,
    });
  const applied = (membershipId: number) => ({
    appliedCaptureDigest: `digest-${membershipId}`,
    appliedCaptureAt: at(10),
    syncedSites: ['example.com'],
    appliedCapture: `baseline-${membershipId}`,
  });
  const computer = async (membershipId: number, forkOf: number | null = null) => {
    const [row] = await db
      .insert(schema.computers)
      .values({
        publicId: newPublicId('computer'),
        membershipId,
        forkOf,
        status: 'ready',
        lastUsedAt: forkOf ? at(20) : null,
        ...applied(membershipId),
      })
      .returning({ id: schema.computers.id });
    return row!.id;
  };
  // Two browsers, the capture from the one that synced first; main, a snapshot of it, and a fork.
  const a = await person(db, 'a');
  const sender = await browser(a.membershipId, 'sender', at(11));
  await browser(a.membershipId, 'later', at(30));
  await capture(a.membershipId, sender);
  const main = await computer(a.membershipId);
  const [snapshot] = await db
    .insert(schema.computerSnapshots)
    .values({ computerId: main, providerSnapshotId: 'snapshot-a', ...applied(a.membershipId) })
    .returning({ id: schema.computerSnapshots.id });
  const fork = await computer(a.membershipId, main);
  // A capture from before browsers were recorded: the most recently synced browser that still syncs gets it.
  const b = await person(db, 'b');
  await browser(b.membershipId, 'signed-out', at(40), { signedOut: true });
  const current = await browser(b.membershipId, 'current', at(20));
  await capture(b.membershipId, null);
  const bComputer = await computer(b.membershipId);
  // No capture, since the browser was removed: its sites go to it, so the next open signs them out.
  const c = await person(db, 'c');
  const removed = await browser(c.membershipId, 'removed', at(5), { removed: true });
  const cComputer = await computer(c.membershipId);
  // No browser at all: nothing to own its state.
  const d = await person(db, 'd');
  await computer(d.membershipId);
  // A computer that never applied anything gets no profile until its first open.
  const e = await person(db, 'e');
  await db.insert(schema.computers).values({ publicId: newPublicId('computer'), membershipId: e.membershipId });

  for (const statement of readFileSync(join(migrations, `${PROFILES}.sql`), 'utf8').split('--> statement-breakpoint'))
    await pg.exec(statement);

  const captures = await db.select().from(schema.browserCaptures).orderBy(schema.browserCaptures.membershipId);
  expect(captures).toMatchObject([
    {
      membershipId: a.membershipId,
      connectedBrowserId: sender,
      digest: `digest-${a.membershipId}`,
      sealed: `sealed-${a.membershipId}`,
      sealedScope: `scope-${a.membershipId}`,
      completedAt: at(10),
      uploadedAt: at(11),
    },
    { membershipId: b.membershipId, connectedBrowserId: current },
  ]);
  const profiles = await db.select().from(schema.computerProfiles).orderBy(schema.computerProfiles.id);
  const first = (membershipId: number) => ({
    chromeProfile: 'default',
    ...applied(membershipId),
  });
  expect(profiles).toMatchObject([
    { computerId: main, snapshotId: null, connectedBrowserId: sender, ...first(a.membershipId) },
    { computerId: fork, connectedBrowserId: sender, ...first(a.membershipId) },
    { computerId: bComputer, connectedBrowserId: current, ...first(b.membershipId) },
    { computerId: cComputer, connectedBrowserId: removed, ...first(c.membershipId) },
    { computerId: null, snapshotId: snapshot!.id, connectedBrowserId: sender, ...first(a.membershipId) },
  ]);
});
