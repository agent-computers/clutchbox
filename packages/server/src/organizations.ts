import { asc, eq, isNull, notExists, sql } from 'drizzle-orm';
import type { Database } from './database';
import { newPublicId } from './ids';
import { memberships, organizations, user } from './schema';

// Organizations and the memberships that put people in them. No 'server-only' here: the migration runner, a plain
// Node script, backfills memberships through it.

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Person = { id: string; name: string; email: string };

// Where a person goes when their account is made: the deployment's choice (ServerHooks.tenancy). Called once per
// account, in a transaction, at sign-up and by the backfill for accounts made before organizations.
export type Tenancy = { join(tx: Transaction, person: Person): Promise<void> };

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
// for their email domain until it can be renamed; everyone after joins it as a member. The lock makes two first
// sign-ups at once create one organization.
export const singleOrganization: Tenancy = {
  async join(tx, person) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agent-computers-single-organization'))`);
    const [existing] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(isNull(organizations.personalUserId))
      .orderBy(asc(organizations.id))
      .limit(1);
    if (!existing) {
      await createOrganization(tx, { name: person.email.split('@')[1] ?? '', owner: person });
      return;
    }
    await tx
      .insert(memberships)
      .values({ publicId: newPublicId('membership'), organizationId: existing.id, userId: person.id, role: 'member' })
      .onConflictDoNothing();
  },
};

// Tables still keyed by user that carry membership_id beside it (schema.ts, memberships).
export const MEMBERSHIP_SCOPED_TABLES = [
  'computers',
  'computer_sessions',
  'tool_calls',
  'connected_browsers',
  'captures',
  'sync_revocations',
  'sync_settings',
  'computer_usage',
  'setups',
] as const;

// Puts every person without a membership into an organization, oldest account first, so a single organization's first
// owner is its first user; then fills membership_id on older rows of people with exactly one membership, the only
// ones whose rows have an unambiguous membership. Safe to run again: it touches only what is still missing.
export async function backfillMemberships(db: Database, tenancy: Tenancy) {
  const people = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(notExists(db.select({ id: memberships.id }).from(memberships).where(eq(memberships.userId, user.id))))
    .orderBy(asc(user.createdAt), asc(user.id));
  for (const person of people) await db.transaction(tx => tenancy.join(tx, person));
  for (const table of MEMBERSHIP_SCOPED_TABLES)
    await db.execute(sql`
      UPDATE ${sql.identifier(table)} AS scoped SET membership_id = sole.id
      FROM (SELECT min(id) AS id, user_id FROM memberships GROUP BY user_id HAVING count(*) = 1) AS sole
      WHERE scoped.user_id = sole.user_id AND scoped.membership_id IS NULL`);
  return people.length;
}
