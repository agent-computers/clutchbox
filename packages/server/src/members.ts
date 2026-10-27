import 'server-only';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { removeAllBrowsers } from './browsers';
import { type ComputerProvider, destroyProviderComputers } from './computers';
import type { Database } from './database';
import { type Limits, noLimits } from './hooks';
import { newPublicId, publicIdPattern } from './ids';
import { revokeMcpGrants } from './mcp';
import { actIn, type Member, type Person } from './organizations';
import * as schema from './schema';

// Members: who is in an organization, joining by email domain, and leaving. Better Auth's organization plugin does the
// rest (organization-auth.ts): invitations, accepting them, and role changes. Leaving and removing stay here, since
// they must revoke the member's tokens first and delete its computer at the provider after, which the plugin's don't.
// Joining is the consent the join screen asks for: the organization's API keys can use a member's synced sites.

export type Role = (typeof schema.MEMBER_ROLES)[number];
export type MembersFailure = {
  error: 'forbidden' | 'not_found' | 'last_owner' | 'already_member' | 'invalid_domain' | 'public_email_domain';
};

// At most this many join domains per organization: a company's few domains, not a list to grow.
export const MAX_JOIN_DOMAINS = 10;
// Domains anyone can get an address at. Allowing one would let any stranger join, and would show the organization to
// everyone with such an address, so they are refused.
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'yandex.com',
  'yandex.ru',
  'zoho.com',
  'qq.com',
  '163.com',
  'fastmail.com',
  'hey.com',
  'tutanota.com',
]);
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const MEMBERSHIP_ID_PATTERN = publicIdPattern('membership');
export const ORGANIZATION_ID_PATTERN = publicIdPattern('organization');

const emailDomain = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();
export const manages = (role: Role) => role === 'owner' || role === 'admin';
// Admins remove only admins and members; owners anyone.
const mayRemove = (actor: Role, role: Role) => actor === 'owner' || role !== 'owner';

export async function roleOf(db: Pick<Database, 'select'>, member: Member): Promise<Role | null> {
  const [row] = await db
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(eq(schema.memberships.id, member.membershipId));
  return row?.role ?? null;
}
const ownerCount = async (db: Pick<Database, 'select'>, organizationId: string) =>
  (
    await db
      .select({ owners: count() })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.organizationId, organizationId), eq(schema.memberships.role, 'owner')))
  )[0]?.owners ?? 0;
// Membership rows of one organization serialize role changes, removals, and leaving, so two of them can never leave
// it without an owner.
const lockOrganization = (tx: Pick<Database, 'execute'>, organizationId: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agent-computers-organization'), hashtext(${organizationId}))`);

// The member's organization and their role there. Who is in it is Better Auth's list-members.
export async function organizationView(db: Database, member: Member) {
  const [view] = await db
    .select({
      id: schema.organizations.publicId,
      name: schema.organizations.name,
      personal: sql<boolean>`${schema.organizations.personalUserId} IS NOT NULL`,
      joinDomains: schema.organizations.joinDomains,
      role: schema.memberships.role,
    })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.organizations.publicId, schema.memberships.organizationId))
    .where(eq(schema.memberships.id, member.membershipId));
  if (!view) return null;
  const { role, ...organization } = view;
  return { organization, role };
}

// member_limit, with the deployment's words, once the organization has as many members as its limit (hooks.ts,
// Limits.members). Under the organization's lock, so two joins cannot both take the last place.
export async function memberLimitFailure(
  tx: Pick<Database, 'execute' | 'select'>,
  limits: Limits,
  organizationId: string,
) {
  const limit = await limits.members(tx, organizationId);
  if (!limit) return null;
  await lockOrganization(tx, organizationId);
  const [row] = await tx
    .select({ members: count() })
    .from(schema.memberships)
    .where(eq(schema.memberships.organizationId, organizationId));
  return (row?.members ?? 0) >= limit.limit ? ({ error: 'member_limit', message: limit.message } as const) : null;
}

export async function join(
  tx: Pick<Database, 'insert' | 'select' | 'update'>,
  userId: string,
  organizationId: string,
  role: Role,
) {
  const [membership] = await tx
    .insert(schema.memberships)
    .values({ publicId: newPublicId('membership'), organizationId, userId, role })
    .onConflictDoNothing()
    .returning({ id: schema.memberships.id });
  if (!membership) return { error: 'already_member' } as const;
  // Someone who joins acts there next.
  await actIn(tx, userId, membership.id);
  const [organization] = await tx
    .select({ id: schema.organizations.publicId, name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.publicId, organizationId));
  return { joined: true as const, organization: organization! };
}

// The email domains whose people may join without an invitation. Lowercased, deduplicated, and checked; a domain anyone
// can get an address at is refused.
export async function setJoinDomains(db: Database, member: Member, domains: string[]) {
  const actor = await roleOf(db, member);
  if (!actor || !manages(actor)) return { error: 'forbidden' } as const;
  const cleaned = [...new Set(domains.map(domain => domain.trim().toLowerCase().replace(/^@/, '')))];
  if (cleaned.length > MAX_JOIN_DOMAINS || cleaned.some(domain => !DOMAIN.test(domain)))
    return { error: 'invalid_domain' } as const;
  if (cleaned.some(domain => PUBLIC_EMAIL_DOMAINS.has(domain))) return { error: 'public_email_domain' } as const;
  await db
    .update(schema.organizations)
    .set({ joinDomains: cleaned, updatedAt: new Date() })
    .where(eq(schema.organizations.publicId, member.organizationId));
  return { joinDomains: cleaned };
}

// Organizations the person may join by their email's domain and is not yet in. The address is verified: no account is
// made without it (auth.ts).
export async function joinableOrganizations(db: Database, person: Pick<Person, 'id' | 'email'>) {
  const domain = emailDomain(person.email);
  return db
    .select({ id: schema.organizations.publicId, name: schema.organizations.name })
    .from(schema.organizations)
    .where(
      and(
        sql`${domain} = ANY(${schema.organizations.joinDomains})`,
        sql`NOT EXISTS (SELECT 1 FROM ${schema.memberships} WHERE ${schema.memberships.organizationId} = ${schema.organizations.publicId} AND ${schema.memberships.userId} = ${person.id})`,
      ),
    )
    .orderBy(asc(schema.organizations.id));
}

export async function joinByDomain(
  db: Database,
  person: Pick<Person, 'id' | 'email'>,
  organizationId: string,
  limits: Limits = noLimits,
) {
  const [organization] = await db
    .select({ id: schema.organizations.publicId })
    .from(schema.organizations)
    .where(
      and(
        eq(schema.organizations.publicId, organizationId),
        sql`${emailDomain(person.email)} = ANY(${schema.organizations.joinDomains})`,
      ),
    );
  if (!organization) return { error: 'not_found' } as const;
  return db.transaction(
    async tx =>
      (await memberLimitFailure(tx, limits, organization.id)) ?? join(tx, person.id, organization.id, 'member'),
  );
}

// The member a membership ID names, in the actor's organization.
async function memberIn(tx: Pick<Database, 'select'>, organizationId: string, membershipId: string) {
  const [row] = await tx
    .select({ id: schema.memberships.id, userId: schema.memberships.userId, role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.publicId, membershipId), eq(schema.memberships.organizationId, organizationId)));
  return row ?? null;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
// Refuses a removal or leave, checked under the organization's lock.
type Check = (tx: Transaction) => Promise<MembersFailure | null>;

// Ends a membership and everything it had in the organization: its browsers are removed and its agents' tokens
// revoked first, so nothing can sync to it or act as it (the browsers stay signed in to the person's other
// organizations), then the membership, whose rows (captures, settings, setup, browsers, computer, sessions,
// tool calls, usage) go with it, then its computers and their snapshots at the provider. `check` runs under the organization's lock before
// anything changes, and again in the transaction that deletes the membership, so two owners leaving at once cannot
// leave it without one; a refusal only that second time (a race) leaves the member in, with tokens to reconnect. The
// computer rows are locked while the membership goes, so a create in flight finds no row to record its computer in and
// kills it (computers.ts, ensureComputer and provisionFork).
async function endMembership(db: Database, provider: ComputerProvider, member: Member, check: Check) {
  const refused = await db.transaction(async tx => {
    await lockOrganization(tx, member.organizationId);
    return check(tx);
  });
  if (refused) return refused;
  await removeAllBrowsers(db, member);
  await revokeMcpGrants(db, member);
  const ended = await db.transaction(async tx => {
    await lockOrganization(tx, member.organizationId);
    const again = await check(tx);
    if (again) return again;
    const computers = await tx
      .select({ id: schema.computers.id, publicId: schema.computers.publicId, sandboxId: schema.computers.sandboxId })
      .from(schema.computers)
      .where(eq(schema.computers.membershipId, member.membershipId))
      .for('update');
    const snapshots = computers.length
      ? await tx
          .select({ id: schema.computerSnapshots.providerSnapshotId })
          .from(schema.computerSnapshots)
          .where(
            inArray(
              schema.computerSnapshots.computerId,
              computers.map(computer => computer.id),
            ),
          )
      : [];
    await tx.delete(schema.memberships).where(eq(schema.memberships.id, member.membershipId));
    return { computers, snapshots: snapshots.map(snapshot => snapshot.id) };
  });
  if ('error' in ended) return ended;
  await destroyProviderComputers(provider, ended.computers, ended.snapshots);
  return null;
}

// An owner removes anyone else, an admin removes admins and members. Leaving is how one removes oneself.
export async function removeMember(db: Database, provider: ComputerProvider, actor: Member, membershipId: string) {
  const target = await memberIn(db, actor.organizationId, membershipId);
  if (!target) return { error: 'not_found' } as const;
  const member = { userId: target.userId, membershipId: target.id, organizationId: actor.organizationId };
  const refused = await endMembership(db, provider, member, async tx => {
    const actorRole = await roleOf(tx, actor);
    const row = await memberIn(tx, actor.organizationId, membershipId);
    if (!actorRole || !manages(actorRole)) return { error: 'forbidden' };
    if (!row) return { error: 'not_found' };
    if (row.id === actor.membershipId || !mayRemove(actorRole, row.role)) return { error: 'forbidden' };
    return null;
  });
  return refused ?? { removed: true as const };
}

// Leaves the organization, unless the member is its last owner.
export async function leaveOrganization(db: Database, provider: ComputerProvider, member: Member) {
  const refused = await endMembership(db, provider, member, async tx => {
    const role = await roleOf(tx, member);
    if (!role) return { error: 'not_found' };
    if (role === 'owner' && (await ownerCount(tx, member.organizationId)) <= 1) return { error: 'last_owner' };
    return null;
  });
  return refused ?? { left: true as const };
}
