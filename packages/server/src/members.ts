import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { disconnectAllBrowsers } from './browsers';
import type { ComputerProvider } from './computers';
import type { Database } from './database';
import { newPublicId, publicIdPattern } from './ids';
import { revokeMcpGrants } from './mcp';
import type { Member, Person } from './organizations';
import * as schema from './schema';

// Members and roles: who is in an organization, how people join it, and how they leave. Owners and admins invite and
// remove; only owners make owners. Anyone can leave, except an organization's last owner. Joining is the consent the
// join screen asks for: the organization's API keys can use a member's synced sites.

export type Role = (typeof schema.MEMBER_ROLES)[number];
export type MembersFailure = {
  error:
    | 'forbidden'
    | 'not_found'
    | 'last_owner'
    | 'already_member'
    | 'invitation_invalid'
    | 'invalid_domain'
    | 'public_email_domain';
};

// How long an invitation link works. Long enough to reach someone over a weekend; a stale link is cheap to remake.
export const INVITATION_TTL_MS = 7 * 24 * 3600_000;
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
export const INVITATION_ID_PATTERN = publicIdPattern('invitation');
export const MEMBERSHIP_ID_PATTERN = publicIdPattern('membership');
export const ORGANIZATION_ID_PATTERN = publicIdPattern('organization');

const hashToken = (token: string) => createHash('sha256').update(token).digest('base64url');
const emailDomain = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();
const manages = (role: Role) => role === 'owner' || role === 'admin';
// Admins grant and change only admin and member; owners anything.
const mayGrant = (actor: Role, role: Role) => actor === 'owner' || role !== 'owner';

async function roleOf(db: Pick<Database, 'select'>, member: Member): Promise<Role | null> {
  const [row] = await db
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(eq(schema.memberships.id, member.membershipId));
  return row?.role ?? null;
}
const ownerCount = async (db: Pick<Database, 'select'>, organizationId: number) =>
  (
    await db
      .select({ owners: count() })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.organizationId, organizationId), eq(schema.memberships.role, 'owner')))
  )[0]?.owners ?? 0;
// Membership rows of one organization serialize role changes, removals, and leaving, so two of them can never leave
// it without an owner.
const lockOrganization = (tx: Pick<Database, 'execute'>, organizationId: number) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agent-computers-organization'), ${organizationId}::int)`);

// The member's organization, their role, and everyone in it.
export async function organizationView(db: Database, member: Member) {
  const [organization] = await db
    .select({
      id: schema.organizations.publicId,
      name: schema.organizations.name,
      personal: sql<boolean>`${schema.organizations.personalUserId} IS NOT NULL`,
      joinDomains: schema.organizations.joinDomains,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, member.organizationId));
  const members = await db
    .select({
      id: schema.memberships.publicId,
      membershipId: schema.memberships.id,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.memberships.role,
      joinedAt: schema.memberships.createdAt,
    })
    .from(schema.memberships)
    .innerJoin(schema.user, eq(schema.user.id, schema.memberships.userId))
    .where(eq(schema.memberships.organizationId, member.organizationId))
    .orderBy(asc(schema.memberships.id));
  const you = members.find(row => row.membershipId === member.membershipId);
  if (!organization || !you) return null;
  return {
    organization,
    role: you.role,
    members: members.map(({ membershipId, ...row }) => ({ ...row, you: membershipId === member.membershipId })),
  };
}

// An invitation link for the member's organization; the token is returned once and stored only hashed.
export async function createInvitation(db: Database, member: Member, role: Role, now = new Date()) {
  const actor = await roleOf(db, member);
  if (!actor || !manages(actor) || !mayGrant(actor, role)) return { error: 'forbidden' } as const;
  const token = randomBytes(24).toString('base64url');
  const [row] = await db
    .insert(schema.invitations)
    .values({
      publicId: newPublicId('invitation', now.getTime()),
      organizationId: member.organizationId,
      role,
      tokenHash: hashToken(token),
      invitedBy: member.membershipId,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    })
    .returning({
      id: schema.invitations.publicId,
      role: schema.invitations.role,
      expiresAt: schema.invitations.expiresAt,
    });
  return { ...row!, token };
}

const pending = (now: Date) =>
  and(
    isNull(schema.invitations.acceptedAt),
    isNull(schema.invitations.revokedAt),
    gt(schema.invitations.expiresAt, now),
  );

// The organization's invitations still waiting to be used, for those who may invite.
export async function listInvitations(db: Database, member: Member, now = new Date()) {
  const actor = await roleOf(db, member);
  if (!actor || !manages(actor)) return { error: 'forbidden' } as const;
  const invitations = await db
    .select({
      id: schema.invitations.publicId,
      role: schema.invitations.role,
      createdAt: schema.invitations.createdAt,
      expiresAt: schema.invitations.expiresAt,
      invitedBy: schema.user.name,
    })
    .from(schema.invitations)
    .leftJoin(schema.memberships, eq(schema.memberships.id, schema.invitations.invitedBy))
    .leftJoin(schema.user, eq(schema.user.id, schema.memberships.userId))
    .where(and(eq(schema.invitations.organizationId, member.organizationId), pending(now)))
    .orderBy(asc(schema.invitations.id));
  return { invitations };
}

export async function revokeInvitation(db: Database, member: Member, invitationId: string, now = new Date()) {
  const actor = await roleOf(db, member);
  if (!actor || !manages(actor)) return { error: 'forbidden' } as const;
  const [row] = await db
    .update(schema.invitations)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.invitations.publicId, invitationId),
        eq(schema.invitations.organizationId, member.organizationId),
        pending(now),
      ),
    )
    .returning({ id: schema.invitations.id });
  return row ? { revoked: true as const } : ({ error: 'not_found' } as const);
}

// What an invitation link offers, for the join screen: null when it is unknown, used, revoked, or expired.
export async function invitationView(db: Database, token: string, now = new Date()) {
  const [row] = await db
    .select({
      organization: schema.organizations.name,
      organizationId: schema.organizations.publicId,
      role: schema.invitations.role,
      expiresAt: schema.invitations.expiresAt,
    })
    .from(schema.invitations)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.invitations.organizationId))
    .where(and(eq(schema.invitations.tokenHash, hashToken(token)), pending(now)));
  return row ?? null;
}

// Joins with the invitation's role and uses it up. A person already in the organization keeps their membership and
// the link stays unused.
export async function acceptInvitation(db: Database, person: Person, token: string, now = new Date()) {
  return db.transaction(async tx => {
    const [invitation] = await tx
      .select({
        id: schema.invitations.id,
        organizationId: schema.invitations.organizationId,
        role: schema.invitations.role,
      })
      .from(schema.invitations)
      .where(and(eq(schema.invitations.tokenHash, hashToken(token)), pending(now)))
      .for('update');
    if (!invitation) return { error: 'invitation_invalid' } as const;
    const joined = await join(tx, person.id, invitation.organizationId, invitation.role);
    if ('error' in joined) return joined;
    await tx
      .update(schema.invitations)
      .set({ acceptedAt: now, updatedAt: now })
      .where(eq(schema.invitations.id, invitation.id));
    return joined;
  });
}

async function join(tx: Pick<Database, 'insert' | 'select'>, userId: string, organizationId: number, role: Role) {
  const [membership] = await tx
    .insert(schema.memberships)
    .values({ publicId: newPublicId('membership'), organizationId, userId, role })
    .onConflictDoNothing()
    .returning({ id: schema.memberships.id });
  if (!membership) return { error: 'already_member' } as const;
  const [organization] = await tx
    .select({ id: schema.organizations.publicId, name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId));
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
    .where(eq(schema.organizations.id, member.organizationId));
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
        sql`NOT EXISTS (SELECT 1 FROM ${schema.memberships} WHERE ${schema.memberships.organizationId} = ${schema.organizations.id} AND ${schema.memberships.userId} = ${person.id})`,
      ),
    )
    .orderBy(asc(schema.organizations.id));
}

export async function joinByDomain(db: Database, person: Pick<Person, 'id' | 'email'>, organizationId: string) {
  const [organization] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(
      and(
        eq(schema.organizations.publicId, organizationId),
        sql`${emailDomain(person.email)} = ANY(${schema.organizations.joinDomains})`,
      ),
    );
  if (!organization) return { error: 'not_found' } as const;
  return db.transaction(tx => join(tx, person.id, organization.id, 'member'));
}

// The member a membership ID names, in the actor's organization.
async function memberIn(tx: Pick<Database, 'select'>, organizationId: number, membershipId: string) {
  const [row] = await tx
    .select({ id: schema.memberships.id, userId: schema.memberships.userId, role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.publicId, membershipId), eq(schema.memberships.organizationId, organizationId)));
  return row ?? null;
}

// An owner sets anyone's role; an admin moves people between admin and member. The last owner stays one until another
// is made.
export async function changeRole(db: Database, actor: Member, membershipId: string, role: Role) {
  return db.transaction(async tx => {
    await lockOrganization(tx, actor.organizationId);
    const actorRole = await roleOf(tx, actor);
    const target = await memberIn(tx, actor.organizationId, membershipId);
    if (!actorRole || !manages(actorRole)) return { error: 'forbidden' } as const;
    if (!target) return { error: 'not_found' } as const;
    if (!mayGrant(actorRole, target.role) || !mayGrant(actorRole, role)) return { error: 'forbidden' } as const;
    if (target.role === 'owner' && role !== 'owner' && (await ownerCount(tx, actor.organizationId)) <= 1)
      return { error: 'last_owner' } as const;
    await tx
      .update(schema.memberships)
      .set({ role, updatedAt: new Date() })
      .where(eq(schema.memberships.id, target.id));
    return { role };
  });
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
// Refuses a removal or leave, checked under the organization's lock.
type Check = (tx: Transaction) => Promise<MembersFailure | null>;

// Ends a membership and everything it had in the organization: its browsers' and agents' tokens first, so nothing can
// sync to it or act as it, then the membership, whose rows (captures, settings, setup, browsers, computer, sessions,
// tool calls, usage) go with it, then its computer at the provider. `check` runs under the organization's lock before
// anything changes, and again in the transaction that deletes the membership, so two owners leaving at once cannot
// leave it without one; a refusal only that second time (a race) leaves the member in, with tokens to reconnect. The
// computer row is locked while the membership goes, so a create in flight finds no row to record its computer in and
// kills it (computers.ts, ensureComputer).
async function endMembership(db: Database, provider: ComputerProvider, member: Member, check: Check) {
  const refused = await db.transaction(async tx => {
    await lockOrganization(tx, member.organizationId);
    return check(tx);
  });
  if (refused) return refused;
  await disconnectAllBrowsers(db, member);
  await revokeMcpGrants(db, member);
  const ended = await db.transaction(async tx => {
    await lockOrganization(tx, member.organizationId);
    const again = await check(tx);
    if (again) return again;
    const rows = await tx
      .select({ publicId: schema.computers.publicId, sandboxId: schema.computers.sandboxId })
      .from(schema.computers)
      .where(eq(schema.computers.membershipId, member.membershipId))
      .for('update');
    await tx.delete(schema.memberships).where(eq(schema.memberships.id, member.membershipId));
    return rows;
  });
  if (!Array.isArray(ended)) return ended;
  for (const computer of ended)
    for (const sandboxId of new Set([computer.sandboxId, await provider.find(computer.publicId)]))
      if (sandboxId) await provider.kill(sandboxId);
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
    if (row.id === actor.membershipId || !mayGrant(actorRole, row.role)) return { error: 'forbidden' };
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
