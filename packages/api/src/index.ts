import 'server-only';
import {
  builtInVerifiedServers,
  captureSchema,
  compareVersions,
  defaultExtensionConfig,
  extensionVersionHeader,
  organizationHeader,
  siteOfHost,
  syncChangeSchema,
  syncSettingsSchema,
  verifiedServersPath,
} from '@agent-computers/capture';
import {
  apiKeyPrincipal,
  computerCallerForMember,
  computerCallerForSession,
  isApiKeyAuthorization,
  type KeyPrincipal,
  latestCaptureForKey,
  membersForKey,
} from '@agent-computers/server/api-keys';
import { type Auth, getPrincipal, signedOAuthClient } from '@agent-computers/server/auth';
import {
  BROWSER_ID_PATTERN,
  browserRemoved,
  listBrowsers,
  removeAllBrowsers,
  removeBrowser,
  type SyncPrincipal,
  signOutBrowser,
  syncPrincipal,
} from '@agent-computers/server/browsers';
import {
  adoptSyncSettings,
  changeSyncSettings,
  deleteCaptures,
  listProfiles,
  profileView,
  saveCapture,
  syncView,
} from '@agent-computers/server/captures';
import { CALL_BUDGET_MS, EXEC_MAX_SECONDS, IDLE_PAUSE_MS } from '@agent-computers/server/computer-timing';
import {
  COMPUTER_ID_PATTERN,
  type ComputerFailure,
  type ComputerProvider,
  closeComputerSession,
  computerSessionState,
  computerView,
  deleteMainComputer,
  handBackComputer,
  issueCdpToken,
  openComputerSession,
  SESSION_ID_PATTERN,
  type SessionHandle,
  setLiveViewClipboard,
  takeOverComputer,
  useComputerSession,
} from '@agent-computers/server/computers';
import {
  CONNECT_APP_ID_PATTERN,
  connectionsForOrganization,
  connectStatus,
  createConnectApp,
  deleteConnectApp,
  joinForConnect,
  listConnectApps,
  MAX_REDIRECT_URIS,
} from '@agent-computers/server/connect';
import type { Database } from '@agent-computers/server/database';
import { heartbeat, heartbeatSchema } from '@agent-computers/server/heartbeat';
import { defaultServerHooks, type ServerHooks } from '@agent-computers/server/hooks';
import { logError } from '@agent-computers/server/log';
import { listMcpGrants, revokeMcpGrant, revokeMcpGrants } from '@agent-computers/server/mcp';
import {
  joinableOrganizations,
  joinByDomain,
  leaveOrganization,
  MAX_JOIN_DOMAINS,
  MEMBERSHIP_ID_PATTERN,
  ORGANIZATION_ID_PATTERN,
  organizationView,
  removeMember,
  setJoinDomains,
} from '@agent-computers/server/members';
import { currentMember, organizationOf, organizationsOf, type Tenancy } from '@agent-computers/server/organizations';
import { closeSetupNotice, noteSetupStep, resetSetup, setupView } from '@agent-computers/server/setup';
import { isTimeZone, setTimeZone } from '@agent-computers/server/time-zones';
import { deleteToolCalls } from '@agent-computers/server/tool-calls';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { failureBody, failureStatus } from './cdp';
import { allowedMutationOrigin, isPinnedExtension, SYNC_PATHS } from './origins';

export { allowedMutationOrigin, extensionCors, tokenPreflight } from './origins';

// App auth (a web session, our web app's) or, on the extension's routes, a sync token, which also names the browser and
// its membership.
type Principal = {
  id: string;
  name: string;
  email: string;
  browser?: SyncPrincipal['browser'];
  member?: SyncPrincipal['member'];
};
// Or, on the developer REST routes alone (KEY_PATH), an organization API key, which acts for its organization.
type Env = { Variables: { principal: Principal; apiKey?: KeyPrincipal } };
const KEY_PATH = /^\/api\/v1\/(members(\/[^/]+\/capture)?|connections|computers\/sessions(\/[^/]+(\/exec)?)?)$/;
// A deployment's own routes, added after the shared middleware so they get its session, origin, and header handling.
export type ApiExtension = (app: Hono<Env>, services: { db: Database }) => void;
// Vercel Functions refuse request bodies over 4.5 MB with their own FUNCTION_PAYLOAD_TOO_LARGE. This limit sits
// under it so oversized captures get capture_too_large, which the extension reports; it matches maxUploadBytes there.
export const MAX_CAPTURE_BYTES = 4_000_000;
// Raise when the upload format changes, so older extension builds are told to update instead of failing.
// Builds before 0.5.0 send no version and count as 0.0.0.
export const MIN_EXTENSION_VERSION = '0.0.0';

// A computer service's refusal (cdp.ts, failureStatus): the free allowance used up is the user's to wait out (403, with
// when it resets); a fork that is gone is 404; a computer starting or being reset elsewhere is worth retrying (409).
function computerFailure(c: Context<Env>, failure: ComputerFailure) {
  return c.json(failureBody(failure), failureStatus(failure));
}

// What each refusal of members.ts and api-keys.ts answers.
const MEMBERS_FAILURE_STATUS = {
  forbidden: 403,
  not_found: 404,
  last_owner: 409,
  already_member: 409,
  invalid_domain: 400,
  public_email_domain: 400,
  connect_app_limit: 409,
  invalid_redirect_uri: 400,
} as const;

export function createApi({
  db,
  auth,
  origin,
  computers,
  hooks = defaultServerHooks,
  extensionVersion,
  minExtensionVersion = MIN_EXTENSION_VERSION,
  extend,
}: {
  db: Database;
  auth: Auth;
  origin: string;
  computers: ComputerProvider;
  hooks?: Pick<ServerHooks, 'metering' | 'operatorAdmin'> & { tenancy?: Pick<Tenancy, 'canCreate'> };
  // The extension build this deployment offers for download.
  extensionVersion?: string | undefined;
  minExtensionVersion?: string;
  extend?: ApiExtension;
}) {
  const latest = extensionVersion ? { latestVersion: extensionVersion } : {};
  const { metering, operatorAdmin, tenancy } = hooks;
  const running = { provider: computers, metering };
  // The member a request acts as: for a sync token, in the organization it names (or the browser's, for a build that
  // names none), or for app auth the person's current one (organizations.ts). A person in no organization here yet
  // gets not_a_member, which our web app answers with its join page, and which tells the extension the person has left
  // the organization it named.
  const memberOf = async (c: Context<Env>) => {
    const principal = c.get('principal');
    const member = principal.browser ? principal.member : await currentMember(db, principal.id);
    // A build from before accounts names no organization; once it has left the one it connected in, it reconnects
    // rather than sync anywhere else.
    if (!member && principal.browser && c.req.header(organizationHeader) === undefined)
      throw new HTTPException(401, { res: Response.json({ error: 'unauthenticated' }, { status: 401 }) });
    if (!member) throw new HTTPException(403, { res: Response.json({ error: 'not_a_member' }, { status: 403 }) });
    return member;
  };
  // The signed-in person, without what a sync token adds.
  const person = (c: Context<Env>) => {
    const { id, name, email } = c.get('principal');
    return { id, name, email };
  };
  // The Clutchbox site is never synced or added.
  const serverSite = siteOfHost(new URL(origin).hostname);
  const app = new Hono<Env>().basePath('/api/v1');
  // CORS for the pinned extension origins on the extension's routes alone (exact paths, so not /sync/disconnect), without
  // credentials: the extension sends its sync token in Authorization. Preflights end here, before authentication.
  const extensionCors = cors({
    origin: from => (isPinnedExtension(from, process.env.EXTENSION_ORIGINS) ? from : null),
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowHeaders: ['authorization', 'content-type', extensionVersionHeader, organizationHeader],
    maxAge: 600,
  });
  for (const path of SYNC_PATHS) app.use(path.slice('/api/v1'.length), extensionCors);
  // The verified servers, which extensions connect to without a warning: public, the same for everyone, and asked
  // for without credentials, so it comes before authentication.
  app.get(verifiedServersPath.slice('/api/v1'.length), c =>
    c.json({ servers: builtInVerifiedServers }, 200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    }),
  );
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const refreshed = new Headers();
    const authorization = c.req.header('authorization');
    let principal: Principal | null;
    // A request with Authorization is judged by its token alone, never by a cookie it also carries.
    // An API key is for a developer's server, which sends no cookies, so no origin applies.
    if (authorization !== undefined && isApiKeyAuthorization(authorization)) {
      const key = KEY_PATH.test(c.req.path) ? await apiKeyPrincipal(auth, authorization) : null;
      if (!key)
        return c.json({ error: 'unauthenticated' }, 401, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
      c.set('apiKey', key);
      return next();
    }
    if (authorization !== undefined) {
      if (!SYNC_PATHS.includes(c.req.path)) return c.json({ error: 'unauthenticated' }, 401);
      principal = await syncPrincipal(db, {
        authorization,
        organization: c.req.header(organizationHeader),
        userAgent: c.req.header('user-agent'),
      });
      if (!principal)
        return c.json({ error: 'unauthenticated' }, 401, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
    } else if (
      SYNC_PATHS.includes(c.req.path) &&
      isPinnedExtension(c.req.header('origin'), process.env.EXTENSION_ORIGINS)
    )
      // Only builds before OAuth call the extension's routes without a token, with the web session; they
      // show this as their update prompt.
      return c.json({ error: 'extension_outdated', ...latest }, 426);
    else principal = await getPrincipal(auth, c.req.raw.headers, refreshed);
    if (!principal) return c.json({ error: 'unauthenticated' }, 401);
    await operatorAdmin.recordActivity(db, principal.id);
    c.set('principal', principal);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const from = c.req.header('origin');
      // A sync token also needs the extension's origin. That keeps a page holding one off these routes, not curl.
      if (
        !allowedMutationOrigin(from, c.req.path, origin, process.env.EXTENSION_ORIGINS) ||
        (principal.browser && !isPinnedExtension(from, process.env.EXTENSION_ORIGINS))
      )
        return c.json({ error: 'forbidden_origin' }, 403);
    }
    await next();
    // The dashboard and the sync client keep an active web session alive through these calls.
    for (const cookie of refreshed.getSetCookie()) c.res.headers.append('Set-Cookie', cookie);
  });
  // The person, the organization they act in (a sync token's, or the current one for app auth; null for a person in
  // no organization here yet), and every organization they belong to, with the one the extension shows first: their
  // personal one, else the one they act in on our web app.
  app.get('/me', async c => {
    const principal = c.get('principal');
    const member = principal.browser ? principal.member : await currentMember(db, principal.id);
    const all = await organizationsOf(db, principal.id);
    const first = all.find(each => each.personal) ?? all.find(each => each.current) ?? all[0];
    return c.json({
      user: person(c),
      organization: member ? await organizationOf(db, member) : null,
      organizations: all.map(({ id, name }) => ({ id, name })),
      defaultOrganization: first?.id ?? null,
    });
  });
  app.get('/mcp/grants', async c => c.json({ grants: await listMcpGrants(db, await memberOf(c)) }));
  app.post('/mcp/revoke', async c => {
    await revokeMcpGrants(db, await memberOf(c));
    return c.json({ revoked: true });
  });
  // One agent. Its own path, so a missing body can never disconnect every agent.
  app.post('/mcp/grants/revoke', async c => {
    const parsed = z
      .object({ clientId: z.string().min(1).max(2048) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    return (await revokeMcpGrant(db, await memberOf(c), parsed.data.clientId))
      ? c.json({ revoked: true })
      : c.json({ error: 'not_found' }, 404);
  });
  app.get('/setup', async c => c.json(await setupView(db, await memberOf(c))));
  app.post('/setup/notice/close', async c => {
    await closeSetupNotice(db, await memberOf(c));
    return c.json({ closed: true });
  });
  // Members (members.ts, which checks who may do what). Any member sees the organization and who is in it; owners and
  // admins remove members and set the join domains. Invitations, accepting them, role changes, and API keys are Better
  // Auth's organization and api-key plugins' endpoints, under /api/auth (organization-auth.ts).
  const answer = (c: Context<Env>, result: object, status: 200 | 201 = 200) => {
    const { error } = result as { error?: keyof typeof MEMBERS_FAILURE_STATUS };
    return error ? c.json({ error }, MEMBERS_FAILURE_STATUS[error]) : c.json(result, status);
  };
  const body = async <T extends z.ZodType>(c: Context<Env>, schema: T) =>
    schema.safeParse(await c.req.json().catch(() => null));
  app.get('/organization', async c => {
    const view = await organizationView(db, await memberOf(c));
    return view ? c.json(view) : c.json({ error: 'not_a_member' }, 403);
  });
  app.put('/organization/join-domains', async c => {
    const parsed = await body(
      c,
      z.object({ domains: z.array(z.string().min(1).max(253)).max(MAX_JOIN_DOMAINS) }).strict(),
    );
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    return answer(c, await setJoinDomains(db, await memberOf(c), parsed.data.domains));
  });
  // Removing or leaving deletes everything the member had in the organization, its computer included.
  app.delete('/organization/members/:id', async c => {
    const id = c.req.param('id');
    if (!MEMBERSHIP_ID_PATTERN.test(id)) return c.json({ error: 'invalid_request' }, 400);
    return answer(c, await removeMember(db, computers, await memberOf(c), id));
  });
  app.post('/organization/leave', async c => {
    return answer(c, await leaveOrganization(db, computers, await memberOf(c)));
  });
  // Joining by email domain, for anyone signed in, in an organization here or not.
  app.get('/organizations/joinable', async c =>
    c.json({ organizations: await joinableOrganizations(db, c.get('principal')) }),
  );
  app.post('/organizations/join', async c => {
    const parsed = await body(c, z.object({ organizationId: z.string().regex(ORGANIZATION_ID_PATTERN) }).strict());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    return answer(c, await joinByDomain(db, c.get('principal'), parsed.data.organizationId));
  });
  // Connect apps, which owners and admins register (connect.ts). The client secret is in the answer to POST alone.
  app.get('/organization/connect-apps', async c => answer(c, await listConnectApps(db, await memberOf(c))));
  app.post('/organization/connect-apps', async c => {
    const parsed = await body(
      c,
      z
        .object({
          name: z.string().trim().min(1).max(100),
          redirectUris: z.array(z.string().min(1).max(2048)).min(1).max(MAX_REDIRECT_URIS),
        })
        .strict(),
    );
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    return answer(c, await createConnectApp(db, await memberOf(c), parsed.data), 201);
  });
  app.delete('/organization/connect-apps/:id', async c => {
    const id = c.req.param('id');
    if (!CONNECT_APP_ID_PATTERN.test(id)) return c.json({ error: 'invalid_request' }, 400);
    return answer(c, await deleteConnectApp(db, await memberOf(c), id));
  });
  // The /connect page, for anyone signed in partway through a Connect app's authorize request: where they stand, and
  // joining the app's organization, which only a request the server signed (the authorize redirect's query) may ask.
  app.post('/connect/status', async c => {
    const parsed = await body(c, z.object({ oauthQuery: z.string().min(1).max(8192) }).strict());
    const clientId = parsed.success ? await signedOAuthClient(auth, parsed.data.oauthQuery) : null;
    if (!clientId) return c.json({ error: 'invalid_request' }, 400);
    const status = await connectStatus(db, c.get('principal').id, clientId);
    return status ? c.json(status) : c.json({ error: 'not_found' }, 404);
  });
  app.post('/connect/join', async c => {
    const parsed = await body(c, z.object({ oauthQuery: z.string().min(1).max(8192) }).strict());
    const clientId = parsed.success ? await signedOAuthClient(auth, parsed.data.oauthQuery) : null;
    if (!clientId) return c.json({ error: 'invalid_request' }, 400);
    return answer(c, await joinForConnect(db, person(c), clientId));
  });
  // The developer REST API, under an organization API key only.
  const keyOf = (c: Context<Env>) => {
    const key = c.get('apiKey');
    if (!key) throw new HTTPException(401, { res: Response.json({ error: 'api_key_required' }, { status: 401 }) });
    return key;
  };
  app.get('/members', async c => c.json({ members: await membersForKey(db, keyOf(c)) }));
  // Which member each Connect app's user is (connect.ts).
  app.get('/connections', async c =>
    c.json({ connections: await connectionsForOrganization(db, keyOf(c).organizationId) }),
  );
  // The default profile's capture, or with ?profile= another of the member's profiles' (by its browser's ID).
  app.get('/members/:id/capture', async c => {
    const key = keyOf(c);
    const id = c.req.param('id');
    const profile = c.req.query('profile');
    if (!MEMBERSHIP_ID_PATTERN.test(id) || (profile !== undefined && !BROWSER_ID_PATTERN.test(profile)))
      return c.json({ error: 'invalid_request' }, 400);
    const result = await latestCaptureForKey(db, key, id, profile);
    if ('error' in result)
      return c.json(
        { error: result.error },
        result.error === 'insufficient_scope' ? 403 : result.error === 'capture_unreadable' ? 503 : 404,
      );
    return c.json(result);
  });
  // Computer sessions for a member, under a key with the computers scope (api-keys.ts): each on a fork of the member's
  // computer, like an MCP agent's, on one of the member's profiles, and owned by the key. The answer to open carries the
  // session's CDP URL, which the CDP proxy serves (cdp.ts), the live-view link the member watches or takes over from,
  // and the member's profiles, to name one in a later open.
  const keyFailure = (
    c: Context<Env>,
    result: ComputerFailure | { readonly error: 'insufficient_scope' } | { readonly error: 'not_found' },
  ) =>
    result.error === 'insufficient_scope'
      ? c.json({ error: 'insufficient_scope' }, 403)
      : result.error === 'not_found'
        ? c.json({ error: 'not_found' }, 404)
        : computerFailure(c, result);
  const computerUnavailable = (c: Context<Env>, sessionId?: string) =>
    c.json(
      {
        error: 'computer_unavailable',
        message: 'The computer did not respond. Check its state before repeating anything that may already have run.',
        ...(sessionId ? { session: sessionId } : {}),
      },
      503,
    );
  const cdpOrigin = origin.replace(/^http/, 'ws');
  app.post('/computers/sessions', async c => {
    const parsed = await body(
      c,
      z
        .object({
          member: z.string().regex(MEMBERSHIP_ID_PATTERN),
          computer: z.string().regex(COMPUTER_ID_PATTERN).optional(),
          session: z.string().regex(SESSION_ID_PATTERN).optional(),
          label: z.string().trim().min(1).max(100).optional(),
          profile: z.string().regex(BROWSER_ID_PATTERN).optional(),
        })
        .strict(),
    );
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const { member, computer, session, label, profile } = parsed.data;
    const caller = await computerCallerForMember(db, keyOf(c), member);
    if ('error' in caller) return keyFailure(c, caller);
    let handle: SessionHandle | undefined;
    try {
      const opened = await openComputerSession(db, running, caller, {
        sessionId: session,
        computerId: computer,
        label,
        profile,
      });
      if ('error' in opened) return computerFailure(c, opened);
      handle = opened;
      await opened.done();
      const token = await issueCdpToken(db, caller, opened.sessionId);
      if (!token) return computerFailure(c, { error: 'session_ended', message: 'The computer session ended.' });
      return c.json(
        {
          session: opened.sessionId,
          computer: { id: opened.computer.id, label: opened.computer.label, created: opened.computer.created },
          cdpUrl: `${cdpOrigin}/api/v1/cdp?token=${token}`,
          liveViewUrl: `${origin}/app/computer?computer=${opened.computer.id}`,
          profile: opened.profile && profileView(opened.profile),
          profiles: opened.profiles.map(profileView),
          sync: opened.sync,
          idlePauseSeconds: IDLE_PAUSE_MS / 1000,
          ...(opened.userHadControl ? { userHadControl: true } : {}),
        },
        201,
      );
    } catch (error) {
      logError('api computer open', error);
      return computerUnavailable(c, handle?.sessionId);
    } finally {
      await handle?.done();
    }
  });
  app.post('/computers/sessions/:id/exec', async c => {
    const parsed = await body(
      c,
      z
        .object({
          command: z.string().min(1).max(8000),
          cwd: z.string().regex(/^\//).max(500).optional(),
          timeoutSeconds: z.int().min(1).max(EXEC_MAX_SECONDS).default(30),
        })
        .strict(),
    );
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const { command, cwd, timeoutSeconds } = parsed.data;
    const caller = await computerCallerForSession(db, keyOf(c), c.req.param('id'));
    if ('error' in caller) return keyFailure(c, caller);
    const deadline = Date.now() + CALL_BUDGET_MS;
    let handle: SessionHandle | undefined;
    try {
      const found = await useComputerSession(db, running, caller, c.req.param('id'));
      if ('error' in found) return computerFailure(c, found);
      handle = found;
      // As computer_exec: a slow resume eats into the budget, and the command then times out instead of the request.
      const effective = Math.max(1, Math.min(timeoutSeconds, Math.floor((deadline - Date.now()) / 1000)));
      const output = await found.session.exec({ command, cwd, timeoutSeconds: effective });
      return c.json({
        ...output,
        ...(effective < timeoutSeconds ? { timeoutSeconds: effective } : {}),
        ...(found.userHadControl ? { userHadControl: true } : {}),
      });
    } catch (error) {
      logError('api computer exec', error);
      return computerUnavailable(c);
    } finally {
      await handle?.done();
    }
  });
  // Where the session stands: open, user_in_control (the member took control in live view; it resumes at the hand-back),
  // or ended. The SDK asks when a CDP connection drops, to reconnect or stop.
  app.get('/computers/sessions/:id', async c => {
    const caller = await computerCallerForSession(db, keyOf(c), c.req.param('id'));
    if ('error' in caller) return keyFailure(c, caller);
    return c.json({ session: c.req.param('id'), state: await computerSessionState(db, caller, c.req.param('id')) });
  });
  // Ends the session, pausing its fork, which keeps its tabs and files for the next open with its computer ID.
  app.delete('/computers/sessions/:id', async c => {
    const caller = await computerCallerForSession(db, keyOf(c), c.req.param('id'));
    if ('error' in caller) return keyFailure(c, caller);
    const closed = await closeComputerSession(db, running, caller, c.req.param('id'));
    return 'error' in closed ? computerFailure(c, closed) : c.json(closed);
  });
  // The person's organizations, and whether the deployment's tenancy lets them create more. Switching and creating are
  // the organization plugin's (set-active, create).
  app.get('/organizations', async c =>
    c.json({ organizations: await organizationsOf(db, c.get('principal').id), canCreate: !!tenancy?.canCreate }),
  );
  // The browser's time zone, which the user's computer follows from its next open.
  app.put('/time-zone', async c => {
    const parsed = z
      .object({ timeZone: z.string().refine(isTimeZone) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    return c.json(await setTimeZone(db, c.get('principal').id, parsed.data.timeZone));
  });
  // Main computer (validation prototype).
  app.get('/computer', async c => c.json(await computerView(db, metering, await memberOf(c))));
  // The browsers syncing to this organization, for the Browser sync page. Removing one stops it syncing here and deletes
  // the capture if it sent it; it keeps syncing to the person's other organizations. Neither path takes a sync token or
  // the extension's origin.
  app.get('/browsers', async c => c.json({ browsers: await listBrowsers(db, await memberOf(c)) }));
  // The browsers with a capture here, each a Chrome profile on the member's computers, the default (synced last) first.
  app.get('/profiles', async c => c.json({ profiles: (await listProfiles(db, await memberOf(c))).map(profileView) }));
  app.post('/browsers/disconnect', async c => {
    const parsed = z
      .object({ id: z.string().regex(BROWSER_ID_PATTERN) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    return (await removeBrowser(db, await memberOf(c), parsed.data.id))
      ? c.json({ disconnected: true })
      : c.json({ error: 'not_found' }, 404);
  });
  // Delete everything: synced browser data first, then the computer and its sign-ins.
  app.delete('/computer', async c => {
    const member = await memberOf(c);
    // Every browser is removed from this organization, and sync turns off here. Agents stay connected.
    await removeAllBrowsers(db, member);
    await deleteCaptures(db, member, { disconnect: true, forget: true });
    // Before the provider, so a provider failure cannot skip it. Agents stay connected.
    await resetSetup(db, member);
    await deleteToolCalls(db, member);
    await deleteMainComputer(db, computers, member);
    return c.json({ deleted: true });
  });
  // Reset: only the computer, so it is rebuilt from the current template; synced data and setup stay.
  app.post('/computer/reset', async c =>
    (await deleteMainComputer(db, computers, await memberOf(c)))
      ? c.json({ reset: true })
      : c.json({ error: 'not_found' }, 404),
  );
  // Live view. The page's heartbeat: each lease it holds goes to its kind's handler
  // (heartbeat.ts), which answers with the lease's status.
  app.post('/heartbeat', async c => {
    const parsed = heartbeatSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    return c.json(await heartbeat(db, running, await memberOf(c), parsed.data));
  });
  // Take control for this page load (lease), or move the user's takeover to it; hand back ends it. Both
  // answer with the lease's live view status, which shows whether it holds the takeover. `computer` names one of the
  // member's forks; without it, the main computer.
  const computer = z.string().regex(COMPUTER_ID_PATTERN).optional();
  const leaseBody = z.object({ lease: z.uuid(), computer }).strict();
  app.post('/computer/takeover', async c => {
    const parsed = leaseBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const { lease, computer: computerId } = parsed.data;
    const result = await takeOverComputer(db, running, await memberOf(c), lease, { computerId });
    if ('error' in result) return computerFailure(c, result);
    return c.json(result);
  });
  app.post('/computer/hand-back', async c => {
    const parsed = leaseBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const { lease, computer: computerId } = parsed.data;
    return c.json(await handBackComputer(db, running, await memberOf(c), lease, { computerId }));
  });
  // Live view's paste: the page sends the user's clipboard text here, then Ctrl+V through the relay, while this page load
  // holds the takeover. The body limit is the uploads' (JSON escapes can grow text);
  // the text's own, MAX_CLIPBOARD_BYTES, is the service's.
  app.post(
    '/computer/clipboard',
    bodyLimit({ maxSize: MAX_CAPTURE_BYTES, onError: c => c.json({ error: 'too_large' }, 413) }),
    async c => {
      const parsed = z
        .object({ lease: z.uuid(), computer, text: z.string() })
        .strict()
        .safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
      const { lease, computer: computerId, text } = parsed.data;
      const result = await setLiveViewClipboard(db, computers, await memberOf(c), lease, text, { computerId });
      if (result === 'too_large') return c.json({ error: 'too_large' }, 413);
      if (result === 'not_in_control') return c.json({ error: 'not_in_control' }, 409);
      return c.json({});
    },
  );
  // Browser sync: the extension uploads with its sync token. `connect` (first upload after Connect in the extension) lifts
  // a dashboard disconnect, but never a disconnected browser's.
  app.post(
    '/captures',
    bodyLimit({ maxSize: MAX_CAPTURE_BYTES, onError: c => c.json({ error: 'capture_too_large' }, 413) }),
    async c => {
      const receivedAt = new Date();
      const { browser } = c.get('principal');
      if (!browser) return c.json({ error: 'extension_only' }, 403);
      if (compareVersions(c.req.header(extensionVersionHeader) ?? '0', minExtensionVersion) < 0)
        return c.json({ error: 'extension_outdated', ...latest }, 426);
      const parsed = z
        .object({ capture: captureSchema, connect: z.literal(true).optional() })
        .strict()
        .safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
      const { capture } = parsed.data;
      const member = await memberOf(c);
      const saved = await saveCapture(db, member, capture, {
        receivedAt,
        connect: parsed.data.connect,
        browser: browser.id,
      });
      if ('error' in saved)
        return c.json(
          { error: saved.error, ...(saved.settings ? { settings: saved.settings } : {}) },
          ({ sync_unavailable: 503, sync_disconnected: 409, superseded: 409, sync_paused: 409 } as const)[saved.error],
        );
      // After the upload commits; a capture with no sites added yet does not count.
      if (capture.scope.mode === 'whole-browser' || capture.scope.sites.length > 0)
        await noteSetupStep(db, member, 'browserSynced');
      return c.json({
        status: saved.status,
        completedAt: saved.completedAt,
        cookieCount: saved.cookieCount,
        ...(saved.settings ? { settings: saved.settings } : {}),
        ...latest,
      });
    },
  );
  // Sync settings: the extension adopts and reads them with its config; the account page reads and edits
  // them. A sync token marks a request as the extension's; the middleware has already required the
  // extension's origin for it.
  const fromExtension = (c: Context<Env>) => c.get('principal').browser !== undefined;
  // `removed`: the organization removed this browser, so the extension drops its sites there.
  app.get('/sync', async c => {
    const member = await memberOf(c);
    const { browser } = c.get('principal');
    const removed = browser && (await browserRemoved(db, browser.id, member)) ? { removed: true } : {};
    return c.json({ ...(await syncView(db, member)), ...removed, config: defaultExtensionConfig, ...latest });
  });
  // The account page may only narrow what is captured; adding sites and resuming need the extension. Exclusions are
  // the user's to edit from either.
  app.patch('/sync', async c => {
    const parsed = syncChangeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const change = parsed.data;
    if (!fromExtension(c) && (change.addSites?.length || change.paused === false))
      return c.json({ error: 'extension_only' }, 403);
    const settings = await changeSyncSettings(db, await memberOf(c), change, serverSite);
    if ('error' in settings)
      return c.json({ error: settings.error }, settings.error === 'sync_unavailable' ? 503 : 409);
    return c.json({ settings });
  });
  // An extension's local settings, kept only when the account has none.
  app.post('/sync/adopt', async c => {
    if (!fromExtension(c)) return c.json({ error: 'extension_only' }, 403);
    const parsed = z
      .object({ settings: syncSettingsSchema })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const settings = await adoptSyncSettings(db, await memberOf(c), parsed.data.settings, serverSite);
    if ('error' in settings) return c.json({ error: settings.error }, 503);
    return c.json({ settings });
  });
  // Turns sync off here and deletes the uploaded copy, keeping the settings for when the extension reconnects. Every
  // browser is removed from this organization first; one syncs here again only once the person adds a site here in
  // the extension (`connect`).
  app.post('/sync/disconnect', async c => {
    const member = await memberOf(c);
    await removeAllBrowsers(db, member);
    await deleteCaptures(db, member, { disconnect: true });
    return c.json({ disconnected: true });
  });
  // The extension's Sign out: that browser's tokens, and every capture it sent, in each of the person's organizations.
  app.delete('/captures', async c => {
    const { browser, id } = c.get('principal');
    if (!browser) return c.json({ error: 'extension_only' }, 403);
    await signOutBrowser(db, id, browser.id);
    return c.json({ deleted: true });
  });
  // After the product's routes, so an extension cannot shadow one.
  extend?.(app, { db });
  app.notFound(c => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    logError(`api ${c.req.method} ${c.req.routePath}`, error);
    return c.json({ error: 'service_unavailable' }, 503);
  });
  return app;
}
