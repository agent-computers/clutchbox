import 'server-only';
import { apiKey } from '@better-auth/api-key';
import { APIError } from 'better-auth/api';
import { organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements, memberAc, ownerAc } from 'better-auth/plugins/organization/access';
import { and, count, eq } from 'drizzle-orm';
import type { Database } from './database';
import { newPublicId } from './ids';
import type { SendEmail } from './mail';
import { actIn, type Tenancy } from './organizations';
import * as schema from './schema';

// Organizations, members, invitations, and organization API keys are Better Auth's organization and api-key plugins,
// over our own tables (auth-schema.ts). What stays ours, and why, is in members.ts and organizations.ts.

// Owners and admins manage members, invitations, and the organization's API keys; members do none of it. The plugin's
// rules decide the rest, and they are ours: admins can't touch owners, only owners make owners, and the last owner
// stays.
const access = createAccessControl({ ...defaultStatements, apiKey: ['create', 'read', 'update', 'delete'] });
const API_KEY_ACTIONS = ['create', 'read', 'update', 'delete'] as const;
export const organizationRoles = {
  owner: access.newRole({ ...ownerAc.statements, apiKey: [...API_KEY_ACTIONS] }),
  admin: access.newRole({ ...adminAc.statements, apiKey: [...API_KEY_ACTIONS] }),
  member: access.newRole({ ...memberAc.statements }),
};

// How long an invitation works. Long enough to reach someone over a weekend; a stale one is cheap to send again.
export const INVITATION_TTL_SECONDS = 7 * 24 * 3600;
// The plugin caps members at 100 by default. An organization's size is the deployment's business (metering bills per
// member), so the cap is only a guard against runaway invitations.
const MEMBERSHIP_LIMIT = 100_000;
// At most this many live API keys per organization: a few per environment, not a list to grow.
export const MAX_API_KEYS = 20;
// What a key is for (schema.ts, API_KEY_SCOPES). It is the only scope so far, so every key has it.
export const API_KEY_PERMISSIONS = { captures: ['read'] };
export const API_KEY_PREFIX = 'ack_';

// The membership the person has in an organization, by the organization's public ID.
async function membershipIn(db: Pick<Database, 'select'>, userId: string, organizationPublicId: string) {
  const [membership] = await db
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.organizationId, organizationPublicId)));
  return membership ?? null;
}
// Makes the person act in the organization from their next request on, as switching does (organizations.ts, actIn).
export async function actInOrganization(db: Database, userId: string, organizationPublicId: string) {
  const membership = await membershipIn(db, userId, organizationPublicId);
  if (membership) await actIn(db, userId, membership.id);
}

export function organizationPlugins(
  db: Database,
  { baseURL, tenancy, sendEmail }: { baseURL: string; tenancy: Tenancy; sendEmail: SendEmail | undefined },
) {
  const { canCreate } = tenancy;
  return [
    organization({
      ac: access,
      roles: organizationRoles,
      // Creating organizations is the deployment's choice (Tenancy.canCreate); the default serves one, made at sign-up.
      allowUserToCreateOrganization: Boolean(canCreate),
      organizationLimit: async user => !(canCreate && (await canCreate(db, user.id))),
      membershipLimit: MEMBERSHIP_LIMIT,
      invitationExpiresIn: INVITATION_TTL_SECONDS,
      cancelPendingInvitationsOnReInvite: true,
      requireEmailVerificationOnInvitation: true,
      // Removing everyone's computers and grants is not something one request should do.
      disableOrganizationDeletion: true,
      // Without SMTP the inviter shares the link, which only an account with the invited address can use.
      ...(sendEmail
        ? {
            sendInvitationEmail: async ({ id, email, organization, inviter }) =>
              sendEmail({
                to: email,
                subject: `Join ${organization.name} on Clutchbox`,
                text: `${inviter.user.name} invited you to join ${organization.name} on Clutchbox.\n\n${baseURL}/join/${id}\n\nSign in with this address to accept. The invitation works for ${INVITATION_TTL_SECONDS / 86400} days.`,
              }),
          }
        : {}),
      organizationHooks: {
        // The name fits the organizations CHECK; the slug is the plugin's and unique, and nothing shows it.
        beforeCreateOrganization: async ({ organization }) => {
          const name = organization.name?.trim() ?? '';
          if (!name || name.length > 100)
            throw new APIError('BAD_REQUEST', { message: 'An organization name is 1 to 100 characters.' });
          return { data: { ...organization, name, slug: newPublicId('organization') } };
        },
        // Creating or joining an organization switches to it, for agents and the extension as well as the web app.
        afterCreateOrganization: async ({ organization, user }) => actInOrganization(db, user.id, organization.id),
        afterAcceptInvitation: async ({ organization, user }) => actInOrganization(db, user.id, organization.id),
      },
    }),
    apiKey({
      references: 'organization',
      defaultPrefix: API_KEY_PREFIX,
      requireName: true,
      maximumNameLength: 100,
      enableMetadata: false,
      permissions: { defaultPermissions: API_KEY_PERMISSIONS },
      // Keys last until revoked, and a developer's server calls as often as it needs.
      keyExpiration: { defaultExpiresIn: null, disableCustomExpiresTime: true },
      rateLimit: { enabled: false },
    }),
  ];
}

// The plugins' endpoints that stay off. Leaving and removing must revoke the member's browser and agent tokens first and
// delete its computer at the provider after, which the plugin's leave (no hooks) and remove don't, so ours do it
// (members.ts); deleting an organization is off in the plugin's options.
export const organizationDisabledPaths = ['/organization/leave', '/organization/remove-member'];

// Whether the organization already has MAX_API_KEYS keys (auth.ts refuses the next create).
export async function apiKeyLimitReached(db: Pick<Database, 'select'>, organizationId: string) {
  const [live] = await db
    .select({ count: count() })
    .from(schema.apikey)
    .where(eq(schema.apikey.referenceId, organizationId));
  return (live?.count ?? 0) >= MAX_API_KEYS;
}
