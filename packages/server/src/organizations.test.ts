import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { and, asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuth } from './auth';
import type { ServerConfig } from './config';
import type { Database } from './database';
import { databaseSchema } from './database-schema';
import {
  actIn,
  backfillMemberships,
  createOrganization,
  currentMember,
  organizationsOf,
  singleOrganization,
  type Tenancy,
} from './organizations';
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
  await migrate(drizzle(template, { schema: databaseSchema }), { migrationsFolder });
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  db = drizzle(pg, { schema: databaseSchema }) as unknown as Database;
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
    .innerJoin(schema.organizations, eq(schema.organizations.publicId, schema.memberships.organizationId))
    .where(eq(schema.memberships.userId, userId))
    .orderBy(asc(schema.memberships.id));
describe('backfill for accounts made before organizations', () => {
  it('makes the oldest account the owner of the one organization, and leaves the rest to join', async () => {
    for (const id of ['first', 'second', 'third']) await person(id);
    expect(await backfillMemberships(db, singleOrganization)).toBe(3);
    const [owner] = await membershipsOf('first');
    expect(owner).toMatchObject({ role: 'owner', personalUserId: null, name: 'acme.test' });
    for (const id of ['second', 'third']) expect(await membershipsOf(id)).toEqual([]);
    expect(await db.select().from(schema.organizations)).toHaveLength(1);
    // Each run hands them over again, and they stay out until they join.
    expect(await backfillMemberships(db, singleOrganization)).toBe(2);
    expect(await db.select().from(schema.memberships)).toHaveLength(1);
  });

  it('gives everyone a personal organization they own under a personal tenancy', async () => {
    for (const id of ['first', 'second']) await person(id);
    await backfillMemberships(db, personal);
    const [first] = await membershipsOf('first');
    const [second] = await membershipsOf('second');
    expect(first).toMatchObject({ role: 'owner', personalUserId: 'first', name: 'Fixture first' });
    expect(second).toMatchObject({ role: 'owner', personalUserId: 'second' });
    expect(first!.organizationId).not.toBe(second!.organizationId);
  });

  it('changes nothing when run again', async () => {
    await person('first');
    await backfillMemberships(db, personal);
    const before = await membershipsOf('first');
    expect(await backfillMemberships(db, personal)).toBe(0);
    expect(await membershipsOf('first')).toEqual(before);
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

  it('makes the first person the owner of the single organization by default, and nobody else a member', async () => {
    await signUp(undefined, 'first');
    await signUp(undefined, 'second');
    const [owner] = await membershipsOf('first');
    expect(owner).toMatchObject({ role: 'owner', personalUserId: null });
    expect(await membershipsOf('second')).toEqual([]);
  });

  it('creates a personal organization under a personal tenancy', async () => {
    await signUp(personal, 'first');
    await signUp(personal, 'second');
    expect(await membershipsOf('first')).toEqual([expect.objectContaining({ role: 'owner', personalUserId: 'first' })]);
    expect(await membershipsOf('second')).toEqual([
      expect.objectContaining({ role: 'owner', personalUserId: 'second' }),
    ]);
  });
});

describe('a person in two organizations', () => {
  it('keeps one personal organization per person', async () => {
    await person('first');
    const owner = { id: 'first', name: 'First', email: 'first@acme.test' };
    expect(await db.transaction(tx => createOrganization(tx, { name: 'First', owner, personal: true }))).not.toBeNull();
    expect(await db.transaction(tx => createOrganization(tx, { name: 'Again', owner, personal: true }))).toBeNull();
    expect(await membershipsOf('first')).toHaveLength(1);
  });
});

describe('switching organizations', () => {
  const membershipIn = async (userId: string, organizationId: string) =>
    (
      await db
        .select({ id: schema.memberships.id })
        .from(schema.memberships)
        .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.organizationId, organizationId)))
    )[0]!.id;
  const sessionsOf = async (userId: string) =>
    (
      await db
        .select({ active: schema.session.activeOrganizationId })
        .from(schema.session)
        .where(eq(schema.session.userId, userId))
    ).map(row => row.active);
  const signedIn = (userId: string, token: string) =>
    db.insert(schema.session).values({
      id: token,
      token,
      userId,
      expiresAt: new Date(Date.now() + 3600_000),
    });

  it("acts in the organization last switched to, in every session, and in the oldest again once it's gone", async () => {
    await person('first');
    await person('other');
    await signedIn('first', 'laptop');
    await signedIn('first', 'phone');
    await signedIn('other', 'theirs');
    const first = { id: 'first', name: 'First', email: 'first@acme.test' };
    const home = (await db.transaction(tx => createOrganization(tx, { name: 'Home', owner: first, personal: true })))!;
    const team = (await db.transaction(tx => createOrganization(tx, { name: 'Team', owner: first })))!;
    const theirs = (await db.transaction(tx =>
      createOrganization(tx, { name: 'Theirs', owner: { id: 'other', name: 'Other', email: 'other@acme.test' } }),
    ))!;
    expect((await currentMember(db, 'first'))?.organizationId).toBe(home);
    await actIn(db, 'first', await membershipIn('first', team));
    expect((await currentMember(db, 'first'))?.organizationId).toBe(team);
    expect(await sessionsOf('first')).toEqual([team, team]);
    // The other person is unaffected.
    expect((await currentMember(db, 'other'))?.organizationId).toBe(theirs);
    expect(await sessionsOf('other')).toEqual([null]);
    expect(
      (await organizationsOf(db, 'first')).map(({ name, personal, role, current }) => [name, personal, role, current]),
    ).toEqual([
      ['Home', true, 'owner', false],
      ['Team', false, 'owner', true],
    ]);
    await db.delete(schema.organizations).where(eq(schema.organizations.publicId, team));
    expect((await currentMember(db, 'first'))?.organizationId).toBe(home);
  });
});
