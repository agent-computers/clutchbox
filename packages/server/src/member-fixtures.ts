import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Database } from './database';
import { newPublicId } from './ids';
import { actIn, createOrganization, type Member, type Person, singleOrganization } from './organizations';
import * as schema from './schema';

// People and memberships for tests only.

// A person and their membership in an organization of their own, which they own.
export async function person(db: Database, id: string): Promise<Member> {
  const values = { id, name: id, email: `${id}@example.test` };
  await db.insert(schema.user).values({ ...values, emailVerified: true });
  const organizationId = await db.transaction(tx => createOrganization(tx, { name: id, owner: values }));
  return membership(db, id, organizationId!);
}
// The person's membership in an organization: their existing one, or a new one as a member.
export async function membership(db: Database, userId: string, organizationId: string): Promise<Member> {
  const [row] = await db
    .insert(schema.memberships)
    .values({ publicId: newPublicId('membership'), organizationId, userId, role: 'member' })
    .onConflictDoUpdate({
      target: [schema.memberships.organizationId, schema.memberships.userId],
      set: { updatedAt: new Date() },
    })
    .returning();
  return { userId, membershipId: row!.id, organizationId: row!.organizationId };
}
// Puts a person in the deployment's one organization, as sign-up does for its first person and an invitation for the
// rest (organizations.ts, singleOrganization).
export async function inTheOrganization(db: Database, person: Person) {
  await db.transaction(tx => singleOrganization.join(tx, person));
  const [organization] = await db
    .select({ id: schema.organizations.publicId })
    .from(schema.organizations)
    .where(isNull(schema.organizations.personalUserId))
    .orderBy(asc(schema.organizations.id))
    .limit(1);
  return membership(db, person.id, organization!.id);
}
// Switches the person to their organization, as the organization plugin's set-active does (organization-auth.ts).
export async function switchTo(db: Database, userId: string, organizationId: string) {
  const [row] = await db
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.organizationId, organizationId)));
  if (!row) throw new Error('not a member');
  await actIn(db, userId, row.id);
}
