import { and, asc, desc, eq, isNull, notExists, sql } from 'drizzle-orm';
import type { Database } from './database';
import { newPublicId } from './ids';
import { memberships, organizations, user, userSettings } from './schema';

// Organizations and the memberships that put people in them. No 'server-only' here: the migration runner, a plain
// Node script, backfills memberships through it.

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Person = { id: string; name: string; email: string };

// Where a person goes when their account is made: the deployment's choice (ServerHooks.tenancy), which may be nowhere
// until they join one (members.ts). join is called in a transaction at sign-up, and again by each migration run for
// accounts still without a membership, so it must be safe to repeat. A deployment that lets people create further
// organizations also gives create, which makes one the person owns and returns its ID; without it, they can't.
export type Tenancy = {
  join(tx: Transaction, person: Person): Promise<void>;
  create?(tx: Transaction, person: Person, name: string): Promise<number | null>;
};

// A person acting in one organization: what membership-scoped data (schema.ts, memberships) is read and written for.
export type Member = { userId: string; membershipId: number; organizationId: number };

// The membership a signed-in person acts in: the one they last switched to (switchOrganization), or else their oldest.
// An MCP grant acts in the membership it names instead (mcp.ts), and a sync token in its browser's. Null for a person
// in no organization here yet: one who has not joined (members.ts), or whose sign-up hook failed (auth.ts) and whom
// the next migration run places.
export async function currentMember(db: Pick<Database, 'select'>, userId: string): Promise<Member | null> {
  const [member] = await db
    .select({ userId: memberships.userId, membershipId: memberships.id, organizationId: memberships.organizationId })
    .from(memberships)
    .leftJoin(userSettings, eq(userSettings.userId, memberships.userId))
    .where(eq(memberships.userId, userId))
    .orderBy(desc(sql`coalesce(${memberships.id} = ${userSettings.currentMembershipId}, false)`), asc(memberships.id))
    .limit(1);
  return member ?? null;
}

// Every organization the person is in, oldest membership first, marking the one they act in.
export async function organizationsOf(db: Pick<Database, 'select'>, userId: string) {
  const current = await currentMember(db, userId);
  const rows = await db
    .select({
      id: organizations.publicId,
      name: organizations.name,
      personal: sql<boolean>`${organizations.personalUserId} IS NOT NULL`,
      role: memberships.role,
      membershipId: memberships.id,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.id));
  return rows.map(({ membershipId, ...row }) => ({ ...row, current: membershipId === current?.membershipId }));
}

// Makes the person act in one of their organizations, by its public ID, from their next request on. False when they
// are not a member of it.
export async function switchOrganization(
  db: Pick<Database, 'select' | 'insert'>,
  userId: string,
  organizationPublicId: string,
) {
  const [membership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.userId, userId), eq(organizations.publicId, organizationPublicId)));
  if (!membership) return false;
  await actIn(db, userId, membership.id);
  return true;
}
// Records the membership the person acts in; joining and creating an organization switch to it this way.
export async function actIn(db: Pick<Database, 'insert'>, userId: string, membershipId: number) {
  await db
    .insert(userSettings)
    .values({ userId, currentMembershipId: membershipId })
    .onConflictDoUpdate({ target: userSettings.userId, set: { currentMembershipId: membershipId } });
}

// Creates an organization through the tenancy's create and makes the person act in it. Null when it refused.
export async function createOrganizationFor(
  db: Database,
  create: NonNullable<Tenancy['create']>,
  person: Person,
  name: string,
) {
  return db.transaction(async tx => {
    const organizationId = await create(tx, person, name);
    if (organizationId === null) return null;
    const [row] = await tx
      .select({ membershipId: memberships.id, id: organizations.publicId, name: organizations.name })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, person.id)));
    if (!row) throw new Error('the tenancy created an organization the person is not in');
    await actIn(tx, person.id, row.membershipId);
    return { id: row.id, name: row.name };
  });
}

// Within the name CHECK on organizations (1 to 100 characters).
const organizationName = (name: string, fallback: string) => (name.trim() || fallback).slice(0, 100);

export async function createOrganization(
  tx: Transaction,
  { name, owner, personal = false }: { name: string; owner: Person; personal?: boolean },
) {
  const [organization] = await tx
    .insert(organizations)
    .values({
      publicId: newPublicId('organization'),
      name: organizationName(name, owner.email),
      personalUserId: personal ? owner.id : null,
    })
    .onConflictDoNothing({ target: organizations.personalUserId })
    .returning({ id: organizations.id });
  if (!organization) return null;
  await tx
    .insert(memberships)
    .values({ publicId: newPublicId('membership'), organizationId: organization.id, userId: owner.id, role: 'owner' });
  return organization.id;
}

// The default: a deployment that serves one organization. The first person to sign up creates it and owns it, named
// for their email domain until it can be renamed. Everyone after joins by invitation or by an allowed email domain
// (members.ts), so an account made by anyone else has no membership until they do. The lock makes two first sign-ups
// at once create one organization.
export const singleOrganization: Tenancy = {
  async join(tx, person) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agent-computers-single-organization'))`);
    const [existing] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(isNull(organizations.personalUserId))
      .limit(1);
    if (!existing) await createOrganization(tx, { name: person.email.split('@')[1] ?? '', owner: person });
  },
};

// Hands every person without a membership to the tenancy, oldest account first, so a single organization's first owner
// is its first user: accounts made before organizations, any whose sign-up hook failed (auth.ts), and people who have
// not joined one yet, whom the tenancy may leave as they are. Returns how many it handed over.
export async function backfillMemberships(db: Database, tenancy: Tenancy) {
  const people = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(notExists(db.select({ id: memberships.id }).from(memberships).where(eq(memberships.userId, user.id))))
    .orderBy(asc(user.createdAt), asc(user.id));
  for (const person of people) await db.transaction(tx => tenancy.join(tx, person));
  return people.length;
}
