import 'server-only';
import {
  captureSchema,
  compareVersions,
  defaultExtensionConfig,
  extensionVersionHeader,
  siteOfHost,
  syncChangeSchema,
  syncSettingsSchema,
} from '@agent-computers/capture';
import { type Auth, getPrincipal } from '@agent-computers/server/auth';
import {
  BROWSER_ID_PATTERN,
  disconnectAllBrowsers,
  disconnectBrowser,
  listBrowsers,
  type SyncPrincipal,
  syncPrincipal,
} from '@agent-computers/server/browsers';
import {
  adoptSyncSettings,
  changeSyncSettings,
  deleteCaptures,
  saveCapture,
  syncView,
} from '@agent-computers/server/captures';
import {
  type ComputerFailure,
  type ComputerProvider,
  computerView,
  deleteMainComputer,
  handBackComputer,
  setLiveViewClipboard,
  takeOverComputer,
} from '@agent-computers/server/computers';
import type { Database } from '@agent-computers/server/database';
import { heartbeat, heartbeatSchema } from '@agent-computers/server/heartbeat';
import { defaultServerHooks, type ServerHooks } from '@agent-computers/server/hooks';
import { logError } from '@agent-computers/server/log';
import { listMcpGrants, revokeMcpGrant, revokeMcpGrants } from '@agent-computers/server/mcp';
import { currentMember } from '@agent-computers/server/organizations';
import { closeSetupNotice, noteSetupStep, resetSetup, setupView } from '@agent-computers/server/setup';
import { isTimeZone, setTimeZone } from '@agent-computers/server/time-zones';
import { deleteToolCalls } from '@agent-computers/server/tool-calls';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { allowedMutationOrigin, isPinnedExtension, SYNC_PATHS } from './origins';

export { allowedMutationOrigin, extensionCors, tokenPreflight } from './origins';

// App auth (a web session, our web app's) or, on the extension's routes, a sync token, which also names the browser.
type Principal = { id: string; name: string; email: string; browser?: SyncPrincipal['browser'] };
type Env = { Variables: { principal: Principal } };
// A deployment's own routes, added after the shared middleware so they get its session, origin, and header handling.
export type ApiExtension = (app: Hono<Env>, services: { db: Database }) => void;
// Vercel Functions refuse request bodies over 4.5 MB with their own FUNCTION_PAYLOAD_TOO_LARGE. This limit sits
// under it so oversized captures get capture_too_large, which the extension reports; it matches maxUploadBytes there.
export const MAX_CAPTURE_BYTES = 4_000_000;
// Raise when the upload format changes, so older extension builds are told to update instead of failing.
// Builds before 0.5.0 send no version and count as 0.0.0.
export const MIN_EXTENSION_VERSION = '0.0.0';

// A computer service's refusal: the free allowance used up is the user's to wait out (403, with when it resets); a
// computer starting or being reset elsewhere is worth retrying (409).
function computerFailure(c: Context<Env>, { error, message, resetsAt }: ComputerFailure) {
  return c.json(
    { error, message, ...(resetsAt ? { resetsAt: resetsAt.toISOString() } : {}) },
    error === 'allowance_exhausted' ? 403 : 409,
  );
}

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
  hooks?: Pick<ServerHooks, 'metering' | 'operatorAdmin'>;
  // The extension build this deployment offers for download.
  extensionVersion?: string | undefined;
  minExtensionVersion?: string;
  extend?: ApiExtension;
}) {
  const latest = extensionVersion ? { latestVersion: extensionVersion } : {};
  const { metering, operatorAdmin } = hooks;
  const running = { provider: computers, metering };
  // The member a signed-in request acts as, for its computer (organizations.ts). An account the tenancy has not placed
  // yet has none until the next migration run places it: the request fails like any unavailable service.
  const memberOf = async (c: Context<Env>) => {
    const member = await currentMember(db, c.get('principal').id);
    if (!member) throw new Error('account has no membership');
    return member;
  };
  // The Agent Computers site is never synced or added.
  const serverSite = siteOfHost(new URL(origin).hostname);
  const app = new Hono<Env>().basePath('/api/v1');
  // CORS for the pinned extension origins on the extension's routes alone (exact paths, so not /sync/disconnect), without
  // credentials: the extension sends its sync token in Authorization. Preflights end here, before authentication.
  const extensionCors = cors({
    origin: from => (isPinnedExtension(from, process.env.EXTENSION_ORIGINS) ? from : null),
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowHeaders: ['authorization', 'content-type', extensionVersionHeader],
    maxAge: 600,
  });
  for (const path of SYNC_PATHS) app.use(path.slice('/api/v1'.length), extensionCors);
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const refreshed = new Headers();
    const authorization = c.req.header('authorization');
    let principal: Principal | null;
    // A request with Authorization is judged by its token alone, never by a cookie it also carries.
    if (authorization !== undefined) {
      if (!SYNC_PATHS.includes(c.req.path)) return c.json({ error: 'unauthenticated' }, 401);
      principal = await syncPrincipal(db, { authorization, userAgent: c.req.header('user-agent') });
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
  app.get('/me', async c => {
    const { id, name, email } = c.get('principal');
    return c.json({ user: { id, name, email } });
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
  app.get('/setup', async c => c.json(await setupView(db, c.get('principal').id)));
  app.post('/setup/notice/close', async c => {
    await closeSetupNotice(db, c.get('principal').id);
    return c.json({ closed: true });
  });
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
  // Connected browsers, for the account page. Disconnecting one revokes its tokens and deletes the capture if it
  // sent it. Neither path takes a sync token or the extension's origin.
  app.get('/browsers', async c => c.json({ browsers: await listBrowsers(db, c.get('principal').id) }));
  app.post('/browsers/disconnect', async c => {
    const parsed = z
      .object({ id: z.string().regex(BROWSER_ID_PATTERN) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    return (await disconnectBrowser(db, c.get('principal').id, { publicId: parsed.data.id }))
      ? c.json({ disconnected: true })
      : c.json({ error: 'not_found' }, 404);
  });
  // Delete everything: synced browser data first, then the computer and its sign-ins.
  app.delete('/computer', async c => {
    const member = await memberOf(c);
    // Every browser disconnects, and sync turns off. Agents stay connected.
    await disconnectAllBrowsers(db, c.get('principal').id);
    await deleteCaptures(db, c.get('principal').id, { disconnect: true, forget: true });
    // Before the provider, so a provider failure cannot skip it. Agents stay connected.
    await resetSetup(db, c.get('principal').id);
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
  // answer with the lease's live view status, which shows whether it holds the takeover.
  const leaseBody = z.object({ lease: z.uuid() }).strict();
  app.post('/computer/takeover', async c => {
    const parsed = leaseBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const result = await takeOverComputer(db, running, await memberOf(c), parsed.data.lease);
    if ('error' in result) return computerFailure(c, result);
    return c.json(result);
  });
  app.post('/computer/hand-back', async c => {
    const parsed = leaseBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    return c.json(await handBackComputer(db, running, await memberOf(c), parsed.data.lease));
  });
  // Live view's paste: the page sends the user's clipboard text here, then Ctrl+V through the relay, while this page load
  // holds the takeover. The body limit is the uploads' (JSON escapes can grow text);
  // the text's own, MAX_CLIPBOARD_BYTES, is the service's.
  app.post(
    '/computer/clipboard',
    bodyLimit({ maxSize: MAX_CAPTURE_BYTES, onError: c => c.json({ error: 'too_large' }, 413) }),
    async c => {
      const parsed = z
        .object({ lease: z.uuid(), text: z.string() })
        .strict()
        .safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
      const result = await setLiveViewClipboard(db, computers, await memberOf(c), parsed.data.lease, parsed.data.text);
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
      const saved = await saveCapture(db, c.get('principal').id, capture, {
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
        await noteSetupStep(db, c.get('principal').id, 'browserSynced');
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
  app.get('/sync', async c =>
    c.json({ ...(await syncView(db, c.get('principal').id)), config: defaultExtensionConfig, ...latest }),
  );
  // The account page may only narrow what is captured; adding sites and resuming need the extension. Exclusions are
  // the user's to edit from either.
  app.patch('/sync', async c => {
    const parsed = syncChangeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const change = parsed.data;
    if (!fromExtension(c) && (change.addSites?.length || change.paused === false))
      return c.json({ error: 'extension_only' }, 403);
    const settings = await changeSyncSettings(db, c.get('principal').id, change, serverSite);
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
    const settings = await adoptSyncSettings(db, c.get('principal').id, parsed.data.settings, serverSite);
    if ('error' in settings) return c.json({ error: settings.error }, 503);
    return c.json({ settings });
  });
  // Turns sync off and deletes the uploaded copy, keeping the settings for when the extension reconnects. Every
  // connected browser disconnects first, so none can lift it with `connect`.
  app.post('/sync/disconnect', async c => {
    await disconnectAllBrowsers(db, c.get('principal').id);
    await deleteCaptures(db, c.get('principal').id, { disconnect: true });
    return c.json({ disconnected: true });
  });
  // The extension's Disconnect: that browser's tokens, and the capture if it sent it.
  app.delete('/captures', async c => {
    const { id, browser } = c.get('principal');
    if (!browser) return c.json({ error: 'extension_only' }, 403);
    await disconnectBrowser(db, id, { id: browser.id });
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
