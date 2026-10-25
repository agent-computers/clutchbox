import 'server-only';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { mcp } from '@better-auth/mcp';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { jwt } from 'better-auth/plugins';
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
import type { ServerConfig } from './config';
import type { Database } from './database';
import { noOperatorAdmin, type OperatorAdmin } from './hooks';
import { MCP_SCOPES } from './mcp';
import * as oauthSchema from './oauth-schema';
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
// The extension's OAuth rules that Better Auth cannot express per client (browsers.ts). User hooks run
// before the provider's own.
const extensionGuards = (db: Database) =>
  createAuthMiddleware(async ctx => {
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

// Tests inject a fetcher for client metadata documents; production uses the DNS-pinning one. Operator admin is a
// hook (hooks.ts): its plugins, and the paths of theirs that stay off.
export function createAuth(
  db: Database,
  config: ServerConfig,
  {
    fetchClientMetadata = fetchClientMetadataResource,
    operatorAdmin = noOperatorAdmin,
  }: { fetchClientMetadata?: typeof fetchClientMetadataResource; operatorAdmin?: OperatorAdmin } = {},
) {
  return betterAuth({
    appName: 'Agent Computers',
    baseURL: config.BETTER_AUTH_URL,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.BETTER_AUTH_URL],
    advanced: { disableOriginCheck: false, disableCSRFCheck: false, database: { joins: true } },
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema, transaction: true }),
    emailAndPassword: { enabled: false },
    socialProviders: {
      // Google asks which account every time: each account has its own computer, so a silently reused
      // Google session can connect an agent to the wrong one.
      google: {
        clientId: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
        disableSignUp: false,
        prompt: 'select_account',
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    account: {
      encryptOAuthTokens: true,
      storeStateStrategy: 'database',
      storeAccountCookie: false,
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
      customRules: { '/sign-in/social': { window: 60, max: 10 } },
    },
    logger: { disabled: true },
    // OAuth errors without a per-flow errorCallbackURL (lost or expired state, MCP authorize
    // errors) land on sign-in instead of Better Auth's development error page.
    onAPIError: { errorURL: `${config.BETTER_AUTH_URL}/sign-in` },
    hooks: { before: extensionGuards(db), after: recordExtensionBrowser(db) },
    // OAuth is owned by Better Auth. Application grants (consents) are checked live by MCP.
    disabledPaths: ['/token', '/oauth2/update-consent', '/oauth2/delete-consent', ...operatorAdmin.disabledPaths],
    plugins: [
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        loginPage: `${config.BETTER_AUTH_URL}/sign-in`,
        consentPage: `${config.BETTER_AUTH_URL}/consent`,
        resource: `${config.BETTER_AUTH_URL}/api/mcp`,
        // `sync` is the extension's alone (browsers.ts): never advertised, and never given to agents, whose CIMD
        // registrations store the MCP scopes. The extension's client row allows only offline_access and sync.
        scopes: [...MCP_SCOPES, SYNC_SCOPE],
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
      }),
      cimd({ fetchClientMetadataResource: fetchClientMetadata, metadataProfile: 'mcp-2026-07-28' }),
      ...operatorAdmin.plugins,
    ],
  });
}
export type Auth = ReturnType<typeof createAuth>;
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
