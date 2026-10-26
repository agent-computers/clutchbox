import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import type { Database } from './database';
import { newPublicId, publicIdPattern } from './ids';
import { join, manages, roleOf } from './members';
import { actIn, type Member, type Person } from './organizations';
import * as schema from './schema';

// Connect: a "Sign in with…" flow on this server for an organization's own apps. The app is an OAuth client the
// organization registers here; it sends a person to /oauth2/authorize with the connect scope, they sign in or sign up,
// join the organization (which is the consent its API keys rely on), connect the extension if they haven't, and
// authorize. The app's backend then gets the member's ID, and the external_user_id it passed, from the token response,
// and reads the member's synced state with its API keys. Removing the member or deleting the app ends the connection.

export const CONNECT_SCOPE = 'connect';
const APP_SCOPES = ['openid', CONNECT_SCOPE];
export const CONNECT_APP_ID_PATTERN = publicIdPattern('connectApp');
export const MAX_CONNECT_APPS = 20;
export const MAX_REDIRECT_URIS = 10;
// The app's own ID for the person: anything up to 255 characters, as most user IDs are.
export const EXTERNAL_USER_ID = /^[\x21-\x7e]{1,255}$/;

// Better Auth's default `hashed` client secret storage: SHA-256, base64url without padding. Its token endpoint
// verifies the secret against this.
const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('base64url');

// An app's redirect URI: https, or http on a loopback host for development; no fragment.
export function redirectUriAllowed(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return !url.hash && !url.username && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
}

export async function createConnectApp(
  db: Database,
  member: Member,
  { name, redirectUris }: { name: string; redirectUris: string[] },
) {
  const role = await roleOf(db, member);
  if (!role || !manages(role)) return { error: 'forbidden' } as const;
  if (!redirectUris.every(redirectUriAllowed)) return { error: 'invalid_redirect_uri' } as const;
  const organization = member.organizationId;
  const [existing] = await db
    .select({ count: count() })
    .from(schema.oauthClient)
    .where(eq(schema.oauthClient.referenceId, organization));
  if ((existing?.count ?? 0) >= MAX_CONNECT_APPS) return { error: 'connect_app_limit' } as const;
  const clientId = newPublicId('connectApp');
  const secret = randomBytes(32).toString('base64url');
  const now = new Date();
  await db.insert(schema.oauthClient).values({
    id: clientId,
    clientId,
    clientSecret: hashSecret(secret),
    disabled: false,
    skipConsent: false,
    scopes: APP_SCOPES,
    clientCredentialsScopes: [],
    name,
    redirectUris: [...new Set(redirectUris)],
    tokenEndpointAuthMethod: 'client_secret_basic',
    applicationType: 'web',
    grantTypes: ['authorization_code'],
    responseTypes: ['code'],
    requirePKCE: true,
    dpopBoundAccessTokens: false,
    // The organization that owns it; Connect apps are exactly the clients with one.
    referenceId: organization,
    createdAt: now,
    updatedAt: now,
  });
  return { app: { id: clientId, name, redirectUris: [...new Set(redirectUris)], secret } };
}

export async function listConnectApps(db: Database, member: Member) {
  const role = await roleOf(db, member);
  if (!role || !manages(role)) return { error: 'forbidden' } as const;
  const organization = member.organizationId;
  const apps = await db
    .select({
      id: schema.oauthClient.clientId,
      name: schema.oauthClient.name,
      redirectUris: schema.oauthClient.redirectUris,
      createdAt: schema.oauthClient.createdAt,
      connections: count(schema.connections.id),
    })
    .from(schema.oauthClient)
    .leftJoin(schema.connections, eq(schema.connections.clientId, schema.oauthClient.clientId))
    .where(eq(schema.oauthClient.referenceId, organization))
    .groupBy(
      schema.oauthClient.clientId,
      schema.oauthClient.name,
      schema.oauthClient.redirectUris,
      schema.oauthClient.createdAt,
    )
    .orderBy(asc(schema.oauthClient.createdAt));
  return { apps };
}

// Deleting an app ends its connections, consents, and tokens with it (their foreign keys cascade).
export async function deleteConnectApp(db: Database, member: Member, clientId: string) {
  const role = await roleOf(db, member);
  if (!role || !manages(role)) return { error: 'forbidden' } as const;
  const organization = member.organizationId;
  const [deleted] = await db
    .delete(schema.oauthClient)
    .where(and(eq(schema.oauthClient.clientId, clientId), eq(schema.oauthClient.referenceId, organization)))
    .returning({ id: schema.oauthClient.id });
  return deleted ? { deleted: true as const } : ({ error: 'not_found' } as const);
}

// A Connect app by its client ID, with the organization that owns it; null for any other client.
export async function connectApp(db: Pick<Database, 'select'>, clientId: string) {
  const [app] = await db
    .select({
      clientId: schema.oauthClient.clientId,
      name: schema.oauthClient.name,
      disabled: schema.oauthClient.disabled,
      organizationId: schema.organizations.publicId,
      organization: schema.organizations.name,
    })
    .from(schema.oauthClient)
    .innerJoin(schema.organizations, eq(schema.organizations.publicId, schema.oauthClient.referenceId))
    .where(eq(schema.oauthClient.clientId, clientId));
  return app && !app.disabled ? app : null;
}

// Where a person stands in a Connect flow for an app: whether they are a member of its organization, and whether a
// browser of theirs syncs to it, which a returning member has and so skips the extension steps.
export async function connectStatus(db: Database, userId: string, clientId: string) {
  const app = await connectApp(db, clientId);
  if (!app) return null;
  const [membership] = await db
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.organizationId, app.organizationId)));
  const [browser] = membership
    ? await db
        .select({ id: schema.connectedBrowsers.id })
        .from(schema.connectedBrowsers)
        .where(
          and(
            eq(schema.connectedBrowsers.membershipId, membership.id),
            isNull(schema.connectedBrowsers.disconnectedAt),
          ),
        )
        .limit(1)
    : [];
  return {
    app: { id: app.clientId, name: app.name ?? 'An app' },
    organization: app.organization,
    member: !!membership,
    browser: !!browser,
  };
}

// Joins the app's organization as a member, if not one already, and acts there, so the extension connects and the
// grant is made for it.
export async function joinForConnect(db: Database, person: Person, clientId: string) {
  const app = await connectApp(db, clientId);
  if (!app) return { error: 'not_found' } as const;
  return db.transaction(async tx => {
    const [membership] = await tx
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.userId, person.id), eq(schema.memberships.organizationId, app.organizationId)));
    if (membership) await actIn(tx, person.id, membership.id);
    else await join(tx, person.id, app.organizationId, 'member');
    return { joined: true as const };
  });
}

// At the token exchange: records the connection for the member the grant is for, with the app's ID for them, and
// returns both for the app. Null when the grant's membership is not the person's in the app's organization, which the
// consent screen prevents; the exchange then fails.
export async function recordConnection(
  db: Database,
  {
    clientId,
    userId,
    membershipPublicId,
    externalUserId,
  }: {
    clientId: string;
    userId: string;
    membershipPublicId: string | undefined;
    externalUserId: string | undefined;
  },
) {
  const app = await connectApp(db, clientId);
  if (!app || !membershipPublicId) return null;
  const [membership] = await db
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.publicId, membershipPublicId),
        eq(schema.memberships.userId, userId),
        eq(schema.memberships.organizationId, app.organizationId),
      ),
    );
  if (!membership) return null;
  const external = externalUserId && EXTERNAL_USER_ID.test(externalUserId) ? externalUserId : null;
  await db
    .insert(schema.connections)
    .values({ clientId, membershipId: membership.id, externalUserId: external })
    .onConflictDoUpdate({
      target: [schema.connections.clientId, schema.connections.membershipId],
      set: { externalUserId: external, updatedAt: new Date() },
    });
  return { member: membershipPublicId, external_user_id: external };
}

// The organization's connections, for an API key: which member each app's user is.
export async function connectionsForOrganization(db: Database, organizationId: string) {
  return db
    .select({
      app: schema.connections.clientId,
      member: schema.memberships.publicId,
      externalUserId: schema.connections.externalUserId,
      connectedAt: schema.connections.createdAt,
    })
    .from(schema.connections)
    .innerJoin(schema.memberships, eq(schema.memberships.id, schema.connections.membershipId))
    .where(eq(schema.memberships.organizationId, organizationId))
    .orderBy(asc(schema.connections.id));
}
