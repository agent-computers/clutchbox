import 'server-only';
import { type Auth, getPrincipal } from '@agent-computers/server/auth';
import {
  LIVE_VIEW_MAX_DURATION_MS,
  LIVE_VIEW_UPSTREAM_OPEN_MS,
  STREAM_MARGIN_MS,
  STREAM_START_MS,
} from '@agent-computers/server/computer-timing';
import {
  type ComputerProvider,
  connectLiveView,
  LEASE_PATTERN,
  liveViewAccess,
} from '@agent-computers/server/computers';
import type { Database } from '@agent-computers/server/database';
import { defaultServerHooks, type ServerHooks } from '@agent-computers/server/hooks';
import { RELAY_CLOSE, relay } from '@agent-computers/server/live-view-relay';
import { logError } from '@agent-computers/server/log';
import { MAX_FRAME } from '@agent-computers/server/rfb-filter';
import { upgradeWebSocket } from '@vercel/functions';
import { WebSocket } from 'ws';

// The live-view relay route: GET /api/v1/live-view?lease=<uuid>, a WebSocket from the /computer page's
// noVNC. Everything that can refuse the connection runs before the upgrade and answers JSON: the browser does not
// apply CORS to a WebSocket handshake, so the exact web origin is checked here (cross-site WebSocket hijacking), with
// app auth and the lease's live watch or takeover. Then the computer is woken, its stream started, and the relay
// joins the two sockets, re-checking the sign-in and the lease as it runs. A computer that must be reset first gets
// an upgrade closed at once with RELAY_CLOSE.needsReset, the only way the page can tell. Never logs URLs, tokens, or
// bytes.

export type LiveViewDeps = {
  db: Database;
  auth: Auth;
  // The web app's origin, the only one allowed to open the socket.
  origin: string;
  computers: ComputerProvider;
  hooks?: Pick<ServerHooks, 'operatorAdmin'>;
  // Tests stand in for Vercel's upgrade.
  upgrade?: typeof upgradeWebSocket;
};

const refuse = (error: string, status: number) =>
  Response.json({ error }, { status, headers: { 'Cache-Control': 'private, no-store' } });

export function liveViewHandler({
  db,
  auth,
  origin,
  computers,
  hooks = defaultServerHooks,
  upgrade = upgradeWebSocket,
}: LiveViewDeps) {
  return async (request: Request): Promise<Response> => {
    // The platform cuts the connection LIVE_VIEW_MAX_DURATION_MS after the function starts.
    const deadlineMs = Date.now() + LIVE_VIEW_MAX_DURATION_MS;
    const principal = await getPrincipal(auth, request.headers);
    if (!principal) return refuse('unauthenticated', 401);
    if (request.headers.get('origin') !== origin) return refuse('forbidden_origin', 403);
    const lease = new URL(request.url).searchParams.get('lease');
    if (!lease || !LEASE_PATTERN.test(lease)) return refuse('invalid_request', 400);
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return refuse('upgrade_required', 426);
    await hooks.operatorAdmin.recordActivity(db, principal.id);
    const userId = principal.id;
    // The relay's periodic read: the same sign-in (not signed out, revoked, or banned since), then the lease.
    const headers = new Headers(request.headers);
    const access = async () =>
      (await getPrincipal(auth, headers))?.id === userId ? liveViewAccess(db, userId, lease) : ('none' as const);
    let upstream: WebSocket;
    try {
      // Wakes a paused computer until the holds let it pause, as the heartbeat that charged them asked.
      const session = await connectLiveView(db, computers, userId, lease);
      // No computer yet, or this page load holds no live watch or takeover on it (its heartbeat comes first).
      if (session === 'not_found') return refuse('not_found', 404);
      if (session === 'not_watching') return refuse('not_watching', 409);
      if (session === 'needs_reset')
        return await upgrade(browser => browser.close(RELAY_CLOSE.needsReset, 'needs reset'));
      const stream = await session.stream(STREAM_START_MS + STREAM_MARGIN_MS);
      upstream = await openUpstream(stream.url, stream.headers);
    } catch (error) {
      logError('live view connect', error);
      return refuse('service_unavailable', 503);
    }
    try {
      return await upgrade(
        browser => {
          const relayed = relay({ browser, upstream, access, deadlineMs });
          // The relay now listens, so the computer's first bytes (its RFB greeting) reach the page.
          upstream.resume();
          return relayed;
        },
        // The filter refuses larger frames anyway; this stops ws from buffering one.
        { maxPayload: MAX_FRAME },
      );
    } catch (error) {
      upstream.terminate();
      throw error;
    }
  };
}

// The computer's websockify, with the provider's traffic token and the Origin websockify expects in the headers
// (stream()), speaking noVNC's binary subprotocol.
function openUpstream(url: string, headers: Record<string, string>) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, 'binary', {
      headers,
      handshakeTimeout: LIVE_VIEW_UPSTREAM_OPEN_MS,
      // Screen updates are already encoded; compressing them again only costs the function CPU.
      perMessageDeflate: false,
    });
    const fail = (error: unknown) => {
      socket.terminate();
      reject(error instanceof Error ? error : new Error('live view upstream closed'));
    };
    socket.once('error', fail);
    socket.once('close', fail);
    socket.once('open', () => {
      socket.off('error', fail);
      socket.off('close', fail);
      // Held until the relay listens: websockify sends the VNC server's greeting at once, and a message nobody
      // listens for is lost.
      socket.pause();
      // Errors before the relay takes the socket over end it through readyState; the relay logs its own.
      socket.on('error', () => {});
      resolve(socket);
    });
  });
}
