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
import { person } from './member-fixtures';
import * as schema from './schema';

// The computer_time migration (0033) on the months computer_usage counted: each copies as seconds of the smallest size,
// so its price stays the same, with the time on an organization's own account apart.
const migrations = fileURLToPath(new URL('../migrations', import.meta.url));
const COMPUTER_TIME = '0033_computer_time';
let pg: PGlite;
let db: Database;
let before: string;
beforeAll(async () => {
  // The migrations up to the one before, then this one's statements on what they left.
  before = mkdtempSync(join(tmpdir(), 'migrations-'));
  cpSync(migrations, before, { recursive: true });
  const journal = JSON.parse(readFileSync(join(before, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag !== COMPUTER_TIME);
  writeFileSync(join(before, 'meta/_journal.json'), JSON.stringify(journal));
  rmSync(join(before, `${COMPUTER_TIME}.sql`));
  pg = new PGlite();
  db = drizzle(pg, { schema: databaseSchema }) as unknown as Database;
  await migrate(drizzle(pg), { migrationsFolder: before });
});
afterAll(async () => {
  await pg.close();
  rmSync(before, { recursive: true, force: true });
});

it('copies each month of computer_usage to computer_time at the same price', async () => {
  const a = await person(db, 'a');
  const b = await person(db, 'b');
  await db.insert(schema.computerUsage).values([
    { membershipId: a.membershipId, month: '2026-09-01', usedSeconds: 60 },
    { membershipId: a.membershipId, month: '2026-10-01', usedSeconds: 3930, runSeconds: 200 },
    { membershipId: b.membershipId, month: '2026-10-01', ownAccountSeconds: 120 },
    { membershipId: b.membershipId, month: '2026-11-01' },
  ]);
  for (const statement of readFileSync(join(migrations, `${COMPUTER_TIME}.sql`), 'utf8').split(
    '--> statement-breakpoint',
  ))
    await pg.exec(statement);
  const rows = await db
    .select({
      membershipId: schema.computerTime.membershipId,
      month: schema.computerTime.month,
      size: schema.computerTime.size,
      account: schema.computerTime.account,
      runSeconds: schema.computerTime.runSeconds,
      pauses: schema.computerTime.pauses,
    })
    .from(schema.computerTime);
  expect(rows).toEqual(
    expect.arrayContaining([
      {
        membershipId: a.membershipId,
        month: '2026-09-01',
        size: '1x',
        account: 'deployment',
        runSeconds: 60,
        pauses: 0,
      },
      {
        membershipId: a.membershipId,
        month: '2026-10-01',
        size: '1x',
        account: 'deployment',
        runSeconds: 3930,
        pauses: 0,
      },
      {
        membershipId: b.membershipId,
        month: '2026-10-01',
        size: '1x',
        account: 'organization',
        runSeconds: 120,
        pauses: 0,
      },
    ]),
  );
  expect(rows).toHaveLength(3);
});
