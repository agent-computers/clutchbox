import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { mcp } from '@better-auth/mcp';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { genericOAuth, jwt, magicLink } from 'better-auth/plugins';
import { sql } from 'drizzle-orm';
import {
  ACCESS_TOKEN_SECONDS,
  EXTENSION_CLIENT_ID,
  guardExtensionRefresh,
  REFRESH_REUSE_SECONDS,
  REFRESH_TOKEN_SECONDS,
  recordBrowser,
  refreshTokenClient,
  SYNC_SCOPE,
} from './browsers';
import { OIDC_PROVIDER_ID, type ServerConfig } from './config';
import { CONNECT_SCOPE, recordConnection } from './connect';
import type { Database } from './database';
import { noOperatorAdmin, type OperatorAdmin } from './hooks';
import { type SendEmail, smtpSender } from './mail';
import { consentMembership, MCP_SCOPES, MEMBERSHIP_CLAIM } from './mcp';
import * as oauthSchema from './oauth-schema';
import { singleOrganization, type Tenancy } from './organizations';
import { account, rateLimit, session, user, verification } from './schema';

// The auth adapter (and so an operator dashboard's generic adapter endpoint) reaches only
// auth tables, never captures, computers, or operations.
const authSchema = { user, session, account, verification, rateLimit, ...oauthSchema };

// An OAuth error answer, shaped like the provider's own.
const oauthError = (error: string, description: string) =>
  new APIError('BAD_REQUEST', { error, error_description: description });
// The client a token or revoke request names: client_id in the body, or HTTP Basic.
function requestClientId(body: unknown, headers: Headers | undefined) {
  const named = body && typeof body === 'object' && 'client_id' in body ? body.client_id : undefined;
  if (typeof named === 'string') return named;
  const basic = /^basic +(\S+)$/i.exec(headers?.get('authorization') ?? '')?.[1];
  if (!basic) return undefined;
  const decoded = Buffer.from(basic, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  try {
    return decodeURIComponent(colon < 0 ? decoded : decoded.slice(0, colon));
  } catch {
    return undefined;
  }
}
const bodyField = (body: unknown, field: string) => {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[field] : undefined;
  return typeof value === 'string' ? value : undefined;
};
// At most this many email links to one address per window, whatever the requester's IP: each one lands in that
// inbox, so the per-IP limit alone would let requests from many IPs flood it. Three covers a resend or two.
const EMAIL_LINKS_PER_ADDRESS = { max: 3, windowSeconds: 15 * 60 };
// Counts the address's recent links in the verification table, under a hash of the address, and records this one
// unless it is over the limit, in one statement.
async function allowEmailLink(db: Database, email: string) {
  const address = createHash('sha256').update(email.trim().toLowerCase()).digest('base64url');
  const identifier = `email-link-sent:${address}`;
  const { max, windowSeconds } = EMAIL_LINKS_PER_ADDRESS;
  const { rows } = await db.execute(sql`
    with expired as (delete from auth_verification where identifier = ${identifier} and expires_at <= now())
    insert into auth_verification (id, identifier, value, expires_at)
    select ${randomUUID()}, ${identifier}, '', now() + make_interval(secs => ${windowSeconds})
    where (select count(*) from auth_verification where identifier = ${identifier} and expires_at > now()) < ${max}
    returning id`);
  return rows.length > 0;
}

// Rules Better Auth cannot express itself: the per-address email link limit, and the extension's OAuth rules that it
// cannot express per client (browsers.ts). User hooks run before the plugins' own.
const requestGuards = (db: Database) =>
  createAuthMiddleware(async ctx => {
    if (ctx.path === '/sign-in/magic-link') {
      const email = bodyField(ctx.body, 'email');
      if (email && !(await allowEmailLink(db, email)))
        throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many sign-in links for this address. Try later.' });
    }
    // A sign-in mid-connect (with a signed authorize request) comes back to the sign-in page, which continues it
    // (resumeAuthorization), rather than Better Auth resuming it: an email link opens in a new tab, and the
    // extension's connect page opens only from our origin or Google's, so its connect flow would end on GitHub's or the
    // identity provider's page. Google keeps Better Auth's resume.
    const signedQuery = bodyField(ctx.body, 'oauth_query');
    if (
      signedQuery &&
      (ctx.path === '/sign-in/magic-link' ||
        (ctx.path === '/sign-in/social' && bodyField(ctx.body, 'provider') !== 'google'))
    ) {
      const body = ctx.body as Record<string, unknown>;
      delete body.oauth_query;
      body.callbackURL = `/sign-in?${signedQuery}`;
    }
    if (ctx.path === '/oauth2/authorize')
      // A consent page would write a consent row for the extension; its disclosure is the consent. Better Auth reads a
      // GET's parameters from the query and a form POST's from the body, so both are checked.
      for (const params of [ctx.query, ctx.body]) {
        const prompt = bodyField(params, 'prompt')?.split(' ') ?? [];
        if (bodyField(params, 'client_id') === EXTENSION_CLIENT_ID && prompt.includes('consent'))
          throw oauthError('invalid_request', 'the extension connects without a consent page');
      }
    if (ctx.path === '/oauth2/token' && bodyField(ctx.body, 'grant_type') === 'refresh_token') {
      const refreshToken = bodyField(ctx.body, 'refresh_token');
      if (
        refreshToken &&
        requestClientId(ctx.body, ctx.request?.headers) === EXTENSION_CLIENT_ID &&
        (await guardExtensionRefresh(db, { refreshToken }))
      )
        throw oauthError('invalid_grant', 'invalid refresh token');
    }
    if (ctx.path === '/oauth2/revoke') {
      // The extension disconnects with DELETE /api/v1/captures. Better Auth revokes every family of the requesting
      // client when a revoked token is presented, so it would disconnect every browser.
      const requester = requestClientId(ctx.body, ctx.request?.headers);
      if (requester === EXTENSION_CLIENT_ID)
        throw oauthError('unauthorized_client', 'the extension disconnects through the sync API');
      // Better Auth revokes the requester's families before it checks that the token is the requester's, so a
      // client could otherwise disconnect another client's tokens with a stale one. Not ours to revoke: say done.
      const token = bodyField(ctx.body, 'token')?.replace(/^bearer\s+/i, '');
      if (token && requester) {
        const holder = await refreshTokenClient(db, token);
        if (holder && holder !== requester) return ctx.json({});
      }
    }
  });

// Records the browser as soon as it exchanges its code, so the account page can list and disconnect it before it
// makes its first API request.
const recordExtensionBrowser = (db: Database) =>
  createAuthMiddleware(async ctx => {
    if (ctx.path !== '/oauth2/token' || bodyField(ctx.body, 'grant_type') !== 'authorization_code') return;
    if (requestClientId(ctx.body, ctx.request?.headers) !== EXTENSION_CLIENT_ID) return;
    const accessToken = bodyField(ctx.context.returned, 'access_token');
    if (accessToken)
      await recordBrowser(db, { accessToken, userAgent: ctx.request?.headers.get('user-agent') ?? undefined });
  });

// How long an email link works. Mail can take a minute; the authorize request a connect flow resumes with it (see
// resumeAuthorization) stays signed for 10 minutes too.
const EMAIL_LINK_SECONDS = 10 * 60;
const discoveryUrl = (issuer: string) =>
  issuer.endsWith('/.well-known/openid-configuration')
    ? issuer
    : `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;

// Tests inject a fetcher for client metadata documents and a fake mail sender; production uses the DNS-pinning
// fetcher and SMTP. Operator admin is a hook (hooks.ts): its plugins, and the paths of theirs that stay off. So is
// tenancy: which organization a new account joins.
export function createAuth(
  db: Database,
  config: ServerConfig,
  {
    fetchClientMetadata = fetchClientMetadataResource,
    operatorAdmin = noOperatorAdmin,
    tenancy = singleOrganization,
    sendEmail,
  }: {
    fetchClientMetadata?: typeof fetchClientMetadataResource;
    operatorAdmin?: OperatorAdmin;
    tenancy?: Tenancy;
    sendEmail?: SendEmail;
  } = {},
) {
  const { SMTP_URL, SMTP_FROM } = config;
  const emailLinks = SMTP_URL && SMTP_FROM ? (sendEmail ?? smtpSender(SMTP_URL, SMTP_FROM)) : undefined;
  // Every provider asks which account every time: each account has its own computer, so a silently reused session at
  // the provider can connect an agent to the wrong one.
  const prompt = 'select_account' as const;
  return betterAuth({
    appName: 'Clutchbox',
    baseURL: config.BETTER_AUTH_URL,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.BETTER_AUTH_URL],
    advanced: { disableOriginCheck: false, disableCSRFCheck: false, database: { joins: true } },
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema, transaction: true }),
    emailAndPassword: { enabled: false },
    socialProviders: {
      ...(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: config.GOOGLE_CLIENT_ID,
              clientSecret: config.GOOGLE_CLIENT_SECRET,
              disableSignUp: false,
              prompt,
            },
          }
        : {}),
      // GitHub reports whether the address it gives is verified (Better Auth reads /user/emails).
      ...(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET
        ? { github: { clientId: config.GITHUB_CLIENT_ID, clientSecret: config.GITHUB_CLIENT_SECRET, prompt } }
        : {}),
    },
    databaseHooks: {
      user: {
        create: {
          // Only an address its provider vouches for makes an account: an email link verifies its own, and OAuth
          // providers say whether theirs is verified. An account is never made unverified, where a later sign-in for
          // the address could inherit what someone else's provider account made.
          before: async user => {
            if (!user.emailVerified)
              throw new APIError('FORBIDDEN', {
                code: 'email_not_verified',
                message: 'The sign-in provider has not verified this email address.',
              });
          },
          // Better Auth runs this once the account's transaction has committed. If it fails, the next migration run's
          // backfill (organizations.ts) puts the account in its organization.
          after: async created => {
            await db.transaction(tx => tenancy.join(tx, created));
          },
        },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    account: {
      encryptOAuthTokens: true,
      storeStateStrategy: 'database',
      storeAccountCookie: false,
      // An address with an account signs in only the way it was made, plus email links, which prove the address
      // itself: another provider's sign-in for it fails with account_not_linked, which the sign-in page explains.
      accountLinking: { enabled: false },
    },
    // Keys on the default x-forwarded-for, which Vercel, or off it the Node server (packages/api/src/node-upgrade.ts),
    // overwrites with the one client IP. Listing headers the platform does not overwrite would let clients spoof fresh
    // buckets; a proxy in front needs its own.
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 60,
      // Google, GitHub, and OIDC all start at /sign-in/social. Email links also have a per-address limit
      // (EMAIL_LINKS_PER_ADDRESS).
      customRules: {
        '/sign-in/social': { window: 60, max: 10 },
        '/sign-in/magic-link': { window: 60, max: 5 },
        '/magic-link/verify': { window: 60, max: 10 },
      },
    },
    logger: { disabled: true },
    // OAuth errors without a per-flow errorCallbackURL (lost or expired state, MCP authorize
    // errors) land on sign-in instead of Better Auth's development error page.
    onAPIError: { errorURL: `${config.BETTER_AUTH_URL}/sign-in` },
    hooks: { before: requestGuards(db), after: recordExtensionBrowser(db) },
    // OAuth is owned by Better Auth. Application grants (consents) are checked live by MCP.
    disabledPaths: ['/token', '/oauth2/update-consent', '/oauth2/delete-consent', ...operatorAdmin.disabledPaths],
    plugins: [
      // The organization's identity provider over OIDC. Its ID token is verified against the discovery document's
      // keys, and only email_verified: true counts as verified.
      ...(config.OIDC_ISSUER && config.OIDC_CLIENT_ID && config.OIDC_CLIENT_SECRET
        ? [
            genericOAuth({
              config: [
                {
                  providerId: OIDC_PROVIDER_ID,
                  name: config.OIDC_NAME ?? 'Single sign-on',
                  discoveryUrl: discoveryUrl(config.OIDC_ISSUER),
                  clientId: config.OIDC_CLIENT_ID,
                  clientSecret: config.OIDC_CLIENT_SECRET,
                  scopes: ['openid', 'email', 'profile'],
                  pkce: true,
                  requireIdTokenVerification: true,
                  prompt,
                  mapProfileToUser: profile => ({
                    emailVerified: profile.email_verified === true || profile.email_verified === 'true',
                  }),
                },
              ],
            }),
          ]
        : []),
      ...(emailLinks
        ? [
            magicLink({
              expiresIn: EMAIL_LINK_SECONDS,
              storeToken: 'hashed',
              sendMagicLink: ({ email, url }) =>
                emailLinks({
                  to: email,
                  subject: 'Sign in to Clutchbox',
                  text: `Open this link to sign in to Clutchbox:\n\n${url}\n\nIt works once, for ${EMAIL_LINK_SECONDS / 60} minutes. If you did not ask to sign in, ignore this email.`,
                }),
            }),
          ]
        : []),
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        loginPage: `${config.BETTER_AUTH_URL}/sign-in`,
        consentPage: `${config.BETTER_AUTH_URL}/consent`,
        resource: `${config.BETTER_AUTH_URL}/api/mcp`,
        // `sync` is the extension's alone (browsers.ts): never advertised, and never given to agents, whose CIMD
        // registrations store the MCP scopes. The extension's client row allows only offline_access and sync.
        scopes: [...MCP_SCOPES, SYNC_SCOPE, CONNECT_SCOPE],
        advertisedMetadata: { scopes_supported: MCP_SCOPES },
        clientRegistrationDefaultScopes: MCP_SCOPES,
        grantTypes: ['authorization_code', 'refresh_token'],
        accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
        // 30 days unused; each refresh issues a new 30-day token.
        refreshTokenExpiresIn: REFRESH_TOKEN_SECONDS,
        refreshTokenReuseInterval: REFRESH_REUSE_SECONDS,
        // A client gets tokens for the MCP resource only when linked to it, as CIMD agents are; this is what keeps
        // sync tokens off /api/mcp.
        enforcePerClientResources: true,
        // Clients identify with CIMD; DCR is deprecated in MCP 2026-07-28 and stays off.
        allowDynamicClientRegistration: false,
        clientPrivileges: () => false,
        // Every agent's grant is for one organization: its consent is stored per membership, under the membership's
        // public ID, and its tokens name that membership (mcp.ts). It is the person's current membership, which the
        // consent screen names and lets them switch first. The extension's connection (the only request for `sync`)
        // is the person's, not a membership's. A Connect app's request (`connect`, connect.ts) first goes to /connect,
        // which joins its organization and switches to it, then comes back here through /oauth2/continue.
        postLogin: {
          page: `${config.BETTER_AUTH_URL}/connect`,
          shouldRedirect: ({ scopes, isContinuation }) => scopes.includes(CONNECT_SCOPE) && !isContinuation,
          consentReferenceId: async ({ user, scopes }) => {
            // Neither agents nor browsers connect for a person in no organization here: they would have nothing to
            // act in or sync to. They join by invitation or email domain (members.ts) and connect again.
            const membership = await consentMembership(db, user.id);
            if (!membership)
              throw oauthError('access_denied', 'the account is not a member of an organization on this server');
            return scopes.includes(SYNC_SCOPE) ? undefined : membership;
          },
        },
        // A Connect app's code exchange records the connection and tells the app who the member is. The grant must be
        // for the person's membership in the app's own organization, or the exchange fails.
        customTokenResponseFields: async ({ grantType, user, scopes, verificationValue }) => {
          if (grantType !== 'authorization_code' || !scopes.includes(CONNECT_SCOPE) || !user) return {};
          const query = (verificationValue?.query ?? {}) as Record<string, unknown>;
          const connection = await recordConnection(db, {
            clientId: String(query.client_id ?? ''),
            userId: user.id,
            membershipPublicId: verificationValue?.referenceId,
            externalUserId: typeof query.external_user_id === 'string' ? query.external_user_id : undefined,
          });
          if (!connection) throw oauthError('invalid_grant', 'the grant is not for a member of the app organization');
          return connection;
        },
        customAccessTokenClaims: ({ referenceId }) => (referenceId ? { [MEMBERSHIP_CLAIM]: referenceId } : {}),
      }),
      cimd({ fetchClientMetadataResource: fetchClientMetadata, metadataProfile: 'mcp-2026-07-28' }),
      ...operatorAdmin.plugins,
    ],
  });
}
export type Auth = ReturnType<typeof createAuth>;
// The client of an authorize request this server signed and that has not expired, from the query it hands its pages
// (consent, /connect); null for any other.
export async function signedOAuthClient(auth: Auth, oauthQuery: string) {
  if (!(await verifyOAuthQueryParams(oauthQuery, (await auth.$context).secret))) return null;
  return new URLSearchParams(oauthQuery).get('client_id');
}
// Pass `refreshed` from a route handler: getSession extends an active session past updateAge,
// and the renewed cookie must reach the browser or it still expires 7 days after sign-in.
// Server components cannot set cookies; their sessions are renewed through /api/v1 calls.
export async function getPrincipal(auth: Auth, headers: Headers, refreshed?: Headers) {
  const { headers: set, response: result } = await auth.api.getSession({
    headers,
    query: { disableCookieCache: true },
    returnHeaders: true,
  });
  for (const cookie of set.getSetCookie()) refreshed?.append('set-cookie', cookie);
  if (!result?.user.emailVerified) return null;
  // An operator's ban (OperatorAdmin): the admin plugin's fields, returned at runtime but untyped.
  const { banned, banExpires } = result.user as { banned?: boolean | null; banExpires?: Date | string | null };
  if (banned && !(banExpires && new Date(banExpires) < new Date())) return null;
  return { id: result.user.id, name: result.user.name, email: result.user.email };
}
// A sign-in mid-connect other than Google's comes back to the sign-in page with the signed authorize request (an
// agent's or the extension's; see requestGuards), and the page continues it from there. Returns the authorize URL to
// go to, or null when the request's signature is invalid or expired, or the session predates it, as prompt=login and
// max_age need.
export async function resumeAuthorization(auth: Auth, headers: Headers, search: URLSearchParams) {
  // Only the parameters the signature covers, as the OAuth client plugin sends them.
  const names = new Set(search.getAll('ba_param'));
  const signed = new URLSearchParams();
  for (const [name, value] of search)
    if (name === 'sig' || name === 'ba_param' || names.has(name)) signed.append(name, value);
  if (!names.size || !(await verifyOAuthQueryParams(signed.toString(), (await auth.$context).secret))) return null;
  const principal = await getPrincipal(auth, headers);
  const result = principal && (await auth.api.getSession({ headers, query: { disableCookieCache: true } }));
  if (!result || new Date(result.session.createdAt).getTime() < Number(signed.get('ba_iat'))) return null;
  for (const name of ['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param', 'max_age']) signed.delete(name);
  const prompt = (signed.get('prompt') ?? '').split(' ').filter(value => value && value !== 'login');
  if (prompt.length) signed.set('prompt', prompt.join(' '));
  else signed.delete('prompt');
  return `/api/auth/oauth2/authorize?${signed}`;
}
