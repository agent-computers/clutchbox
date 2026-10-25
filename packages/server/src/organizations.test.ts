import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuth } from './auth';
import type { ServerConfig } from './config';
import type { Database } from './database';
import { backfillMemberships, createOrganization, singleOrganization, type Tenancy } from './organizations';
import * as schema from './schema';

const config: ServerConfig = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/synthetic',
  BETTER_AUTH_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'synthetic-only',
};
// A personal organization for every person, as a deployment serving many organizations might choose.
const personal: Tenancy = {
  async join(tx, person) {
    await createOrganization(tx, { name: person.name, owner: person, personal: true });
  },
};

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
let template: PGlite;
let pg: PGlite;
let db: Database;
beforeAll(async () => {
  template = new PGlite();
  await migrate(drizzle(template, { schema }), { migrationsFolder });
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  db = drizzle(pg, { schema }) as unknown as Database;
});
afterEach(() => pg.close());

let created = 0;
// An account made directly, as before organizations existed: no sign-up hook runs.
async function person(id: string) {
  created += 1;
  await db.insert(schema.user).values({
    id,
    name: `Fixture ${id}`,
    email: `${id}@${id === 'outsider' ? 'other.test' : 'acme.test'}`,
    emailVerified: true,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, created)),
  });
}
// A row in one table of each kind: one row per person, and many rows per person.
async function rows(userId: string) {
  await db.insert(schema.syncSettings).values({ userId, sealed: 'sealed' });
  await db.insert(schema.computerUsage).values({ userId, month: '2026-10-01' });
}
const membershipsOf = (userId: string) =>
  db
    .select({
      id: schema.memberships.id,
      role: schema.memberships.role,
      organizationId: schema.memberships.organizationId,
      personalUserId: schema.organizations.personalUserId,
      name: schema.organizations.name,
    })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.organizationId))
    .where(eq(schema.memberships.userId, userId))
    .orderBy(asc(schema.memberships.id));
const scopedRows = async (userId: string) => [
  ...(await db
    .select({ membershipId: schema.syncSettings.membershipId })
    .from(schema.syncSettings)
    .where(eq(schema.syncSettings.userId, userId))),
  ...(await db
    .select({ membershipId: schema.computerUsage.membershipId })
    .from(schema.computerUsage)
    .where(eq(schema.computerUsage.userId, userId))),
];

describe('backfill for accounts made before organizations', () => {
  it('puts everyone in one organization, owned by the oldest account, and fills their rows', async () => {
    for (const id of ['first', 'second', 'third']) {
      await person(id);
      await rows(id);
    }
    expect(await backfillMemberships(db, singleOrganization)).toBe(3);
    const [owner] = await membershipsOf('first');
    expect(owner).toMatchObject({ role: 'owner', personalUserId: null, name: 'acme.test' });
    for (const id of ['second', 'third'])
      expect(await membershipsOf(id)).toEqual([
        expect.objectContaining({ role: 'member', organizationId: owner!.organizationId }),
      ]);
    expect(await db.select().from(schema.organizations)).toHaveLength(1);
    for (const id of ['first', 'second', 'third']) {
      const [membership] = await membershipsOf(id);
      expect(await scopedRows(id)).toEqual([{ membershipId: membership!.id }, { membershipId: membership!.id }]);
    }
  });

  it('gives everyone a personal organization they own under a personal tenancy', async () => {
    for (const id of ['first', 'second']) {
      await person(id);
      await rows(id);
    }
    await backfillMemberships(db, personal);
    const [first] = await membershipsOf('first');
    const [second] = await membershipsOf('second');
    expect(first).toMatchObject({ role: 'owner', personalUserId: 'first', name: 'Fixture first' });
    expect(second).toMatchObject({ role: 'owner', personalUserId: 'second' });
    expect(first!.organizationId).not.toBe(second!.organizationId);
    expect(await scopedRows('second')).toEqual([{ membershipId: second!.id }, { membershipId: second!.id }]);
  });

  it('changes nothing when run again', async () => {
    await person('first');
    await rows('first');
    await backfillMemberships(db, personal);
    const before = { memberships: await membershipsOf('first'), rows: await scopedRows('first') };
    expect(await backfillMemberships(db, personal)).toBe(0);
    expect({ memberships: await membershipsOf('first'), rows: await scopedRows('first') }).toEqual(before);
    expect(await db.select().from(schema.organizations)).toHaveLength(1);
  });
});

describe('sign-up', () => {
  // Through Better Auth's own account creation, which runs its database hooks as a sign-up does.
  async function signUp(tenancy: Tenancy | undefined, id: string) {
    const auth = createAuth(db, config, tenancy ? { tenancy } : {});
    const context = await auth.$context;
    await context.internalAdapter.createUser(
      {
        id,
        name: `Fixture ${id}`,
        email: `${id}@acme.test`,
        emailVerified: true,
      },
      { method: 'oauth' },
    );
  }

  it('joins the single organization by default: the first person owns it, later ones are members', async () => {
    await signUp(undefined, 'first');
    await signUp(undefined, 'second');
    const [owner] = await membershipsOf('first');
    expect(owner).toMatchObject({ role: 'owner', personalUserId: null });
    expect(await membershipsOf('second')).toEqual([
      expect.objectContaining({ role: 'member', organizationId: owner!.organizationId }),
    ]);
  });

  it('creates a personal organization under a personal tenancy', async () => {
    await signUp(personal, 'first');
    await signUp(personal, 'second');
    expect(await membershipsOf('first')).toEqual([expect.objectContaining({ role: 'owner', personalUserId: 'first' })]);
    expect(await membershipsOf('second')).toEqual([
      expect.objectContaining({ role: 'owner', personalUserId: 'second' }),
    ]);
  });

  it('fills membership_id on rows written after sign-up, without the writer naming it', async () => {
    await signUp(personal, 'first');
    await rows('first');
    const [membership] = await membershipsOf('first');
    expect(await scopedRows('first')).toEqual([{ membershipId: membership!.id }, { membershipId: membership!.id }]);
  });
});

describe('a person in two organizations', () => {
  it('fills new rows with their oldest membership and leaves older, ambiguous rows to the move', async () => {
    await person('first');
    await rows('first');
    await person('outsider');
    await db.transaction(tx => personal.join(tx, { id: 'first', name: 'First', email: 'first@acme.test' }));
    const shared = await db.transaction(tx =>
      createOrganization(tx, {
        name: 'Team',
        owner: { id: 'outsider', name: 'Outsider', email: 'outsider@other.test' },
      }),
    );
    await db.insert(schema.memberships).values({
      publicId: 'mem_test',
      organizationId: shared!,
      userId: 'first',
      role: 'member',
    });
    const [oldest, team] = await membershipsOf('first');
    expect(team).toMatchObject({ organizationId: shared, role: 'member' });

    // Rows from before the person had any membership could belong to either organization: the backfill leaves them.
    await backfillMemberships(db, personal);
    expect(await scopedRows('first')).toEqual([{ membershipId: null }, { membershipId: null }]);

    await db.insert(schema.setups).values({ userId: 'first' });
    const [setup] = await db.select().from(schema.setups).where(eq(schema.setups.userId, 'first'));
    expect(setup!.membershipId).toBe(oldest!.id);
  });

  it('keeps one personal organization per person', async () => {
    await person('first');
    const owner = { id: 'first', name: 'First', email: 'first@acme.test' };
    expect(await db.transaction(tx => createOrganization(tx, { name: 'First', owner, personal: true }))).not.toBeNull();
    expect(await db.transaction(tx => createOrganization(tx, { name: 'Again', owner, personal: true }))).toBeNull();
    expect(await membershipsOf('first')).toHaveLength(1);
  });
});
