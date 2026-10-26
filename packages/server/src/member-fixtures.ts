import type { Database } from './database';
import { newPublicId } from './ids';
import { createOrganization, type Member } from './organizations';
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
export async function membership(db: Database, userId: string, organizationId: number): Promise<Member> {
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
