import { asc, desc, eq, isNull, notExists, sql } from 'drizzle-orm';
import type { Database } from './database';
import { newPublicId } from './ids';
import { memberships, organizations, session, user, userSettings } from './schema';

// Organizations and the memberships that put people in them. No 'server-only' here: the migration runner, a plain
// Node script, backfills memberships through it.

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Person = { id: string; name: string; email: string };

// Where a person goes when their account is made: the deployment's choice (ServerHooks.tenancy), which may be nowhere
// until they join one (members.ts). join is called in a transaction at sign-up, and again by each migration run for
// accounts still without a membership, so it must be safe to repeat. It stays ours rather than Better Auth's
// organization plugin's, which creates organizations only in a request. A deployment that lets people create further
// organizations (through the plugin, organization-auth.ts) also gives canCreate, which says whether this person may
// create one now; without it, nobody can.
export type Tenancy = {
  join(tx: Transaction, person: Person): Promise<void>;
  canCreate?(db: Pick<Database, 'select'>, userId: string): Promise<boolean>;
};

// A person acting in one organization: what membership-scoped data (schema.ts, memberships) is read and written for.
// organizationId is the organization's public ID, which memberships reference it by.
export type Member = { userId: string; membershipId: number; organizationId: string };

// The membership a signed-in person acts in: the one they last switched to (actIn), or else their oldest.
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
    .innerJoin(organizations, eq(organizations.publicId, memberships.organizationId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.id));
  return rows.map(({ membershipId, ...row }) => ({ ...row, current: membershipId === current?.membershipId }));
}

// The organization a member acts in, by its public ID and name: what /me names to a connected extension.
export async function organizationOf(db: Pick<Database, 'select'>, member: Member) {
  const [organization] = await db
    .select({ id: organizations.publicId, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.publicId, member.organizationId));
  return organization ?? null;
}

// Records the membership the person acts in, and makes their sessions act in its organization too, so Better Auth's
// organization endpoints, which use the session's active organization, agree with ours. Switching (the plugin's
// set-active), joining, and creating an organization all come here (organization-auth.ts, members.ts).
export async function actIn(db: Pick<Database, 'insert' | 'update' | 'select'>, userId: string, membershipId: number) {
  await db
    .insert(userSettings)
    .values({ userId, currentMembershipId: membershipId })
    .onConflictDoUpdate({ target: userSettings.userId, set: { currentMembershipId: membershipId } });
  const [membership] = await db
    .select({ organizationId: memberships.organizationId })
    .from(memberships)
    .where(eq(memberships.id, membershipId));
  if (membership)
    await db.update(session).set({ activeOrganizationId: membership.organizationId }).where(eq(session.userId, userId));
}
// The organization a new session starts in: the person's current one (Better Auth's session create hook, auth.ts).
export async function activeOrganizationOf(db: Pick<Database, 'select'>, userId: string) {
  const member = await currentMember(db, userId);
  return member?.organizationId ?? null;
}

// Within the name CHECK on organizations (1 to 100 characters).
const organizationName = (name: string, fallback: string) => (name.trim() || fallback).slice(0, 100);

export async function createOrganization(
  tx: Transaction,
  { name, owner, personal = false }: { name: string; owner: Person; personal?: boolean },
) {
  const publicId = newPublicId('organization');
  const [organization] = await tx
    .insert(organizations)
    .values({
      publicId,
      name: organizationName(name, owner.email),
      slug: publicId,
      personalUserId: personal ? owner.id : null,
    })
    .onConflictDoNothing({ target: organizations.personalUserId })
    .returning({ publicId: organizations.publicId });
  if (!organization) return null;
  await tx
    .insert(memberships)
    .values({ publicId: newPublicId('membership'), organizationId: publicId, userId: owner.id, role: 'owner' });
  return publicId;
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
