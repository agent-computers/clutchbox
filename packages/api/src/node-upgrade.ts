import { AsyncLocalStorage } from 'node:async_hooks';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { beginShutdown } from '@clutchbox/server/shutdown';

// WebSocket upgrades on a plain Node server, for routes that upgrade with @vercel/functions' upgradeWebSocket (the
// live-view relay). Vercel's runtime runs such a route as an ordinary request and hands upgradeWebSocket the raw
// socket through its request context; Next.js's own server instead ends every upgrade to an app route without running
// it. So the web app's Node server (its server.ts) passes each WebSocket handshake here, which runs it through
// the framework's request listener inside that same request context. The route's checks and refusals are unchanged:
// a refusal is written to the socket as an ordinary HTTP response, and an upgrade hands the socket to ws.
// nodeServer is that whole server, so its tests run what the web app runs.

type UpgradeContext = { upgradeWebSocket: () => { req: IncomingMessage; socket: Duplex; head: Buffer } };
type RequestListener = (request: IncomingMessage, response: ServerResponse) => unknown;

const contexts = new AsyncLocalStorage<UpgradeContext>();
// The symbol @vercel/functions reads its request context from (its get-context.js).
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

const isWebSocketUpgrade = (request: IncomingMessage) => request.headers.upgrade?.toLowerCase() === 'websocket';

function nodeUpgrades(listener: RequestListener) {
  (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = { get: () => contexts.getStore() };
  return (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // An upgrade request's socket is a net.Socket; the 'upgrade' event only types it as a Duplex.
    const response = new ServerResponse(request);
    response.assignSocket(socket as Socket);
    let upgraded = false;
    socket.on('error', () => {});
    // A refusal ends the connection once written, as a handshake answered with anything but 101 must.
    response.once('finish', () => {
      if (!upgraded) socket.end();
    });
    const context: UpgradeContext = {
      upgradeWebSocket: () => {
        if (upgraded) throw new Error('upgradeWebSocket can be called once per request');
        upgraded = true;
        // ws owns the socket from here: what the framework writes once the route returns (its 204) is dropped.
        response.detachSocket(socket as Socket);
        response.writeHead = () => response;
        response.write = () => true;
        response.end = () => response;
        // Frameworks end a request's lifecycle on the response's close, which after an upgrade is the socket's; let
        // ws report its own close first.
        socket.once('close', () => setImmediate(() => response.emit('close')));
        return { req: request, socket, head };
      },
    };
    contexts.run(context, async () => {
      try {
        await listener(request, response);
      } catch {
        socket.destroy();
      }
    });
  };
}

// Where a request's client address comes from, from the server's environment.
export type ClientAddress = {
  // TRUST_PROXY=true: a reverse proxy in front overwrites X-Forwarded-For with the client's address.
  trustProxy?: boolean;
  // CLIENT_IP_HEADER: a header the platform's own proxy sets to the client's address, which clients can't set
  // themselves, such as Fly.io's Fly-Client-IP.
  clientIpHeader?: string;
  // FORWARDED_SECRET: a secret that a proxy reaching this server through the platform's, such as another host's
  // rewrite, sends in X-Forwarded-Secret, with the client's address first in X-Forwarded-For.
  forwardedSecret?: string;
};
export const clientAddressFromEnv = (env: NodeJS.ProcessEnv = process.env): ClientAddress => ({
  trustProxy: env.TRUST_PROXY === 'true',
  ...(env.CLIENT_IP_HEADER && { clientIpHeader: env.CLIENT_IP_HEADER.toLowerCase() }),
  ...(env.FORWARDED_SECRET && { forwardedSecret: env.FORWARDED_SECRET }),
});

const sameSecret = (sent: string, secret: string) =>
  sent.length === secret.length && timingSafeEqual(Buffer.from(sent), Buffer.from(secret));

// The web app's HTTP server off Vercel: every request, and every WebSocket handshake, goes to the framework's listener.
// Other upgrades (h2c) are refused: no route answers one, and an unanswered upgrade would hold its socket open.
//
// Better Auth keys its rate limits on X-Forwarded-For, which Vercel overwrites with the client's IP and Next.js fills
// only when it is missing, so a client reaching this server directly could send a fresh one per request and never be
// limited. So it is set to the client's address as ClientAddress finds it: the first X-Forwarded-For entry of a
// forwarder that proved itself with the secret, X-Forwarded-For as a trusted proxy left it (one that appends to it
// would let clients choose again), the platform's client header, or else the connection's own address. The secret's
// header never reaches the routes.
export function nodeServer(
  listener: RequestListener,
  { trustProxy = false, clientIpHeader, forwardedSecret }: ClientAddress = {},
) {
  const clientAddress = (request: IncomingMessage) => {
    const sent = request.headers['x-forwarded-secret'];
    delete request.headers['x-forwarded-secret'];
    const forwardedFor = request.headers['x-forwarded-for'];
    if (forwardedSecret && typeof sent === 'string' && sameSecret(sent, forwardedSecret) && forwardedFor) {
      request.headers['x-forwarded-for'] = String(forwardedFor).split(',')[0]?.trim() ?? '';
      return;
    }
    if (trustProxy) return;
    const platform = clientIpHeader ? request.headers[clientIpHeader] : undefined;
    request.headers['x-forwarded-for'] =
      (typeof platform === 'string' && platform) || (request.socket.remoteAddress ?? '');
  };
  const webSocketUpgrade = nodeUpgrades(listener);
  const server = createServer((request, response) => {
    clientAddress(request);
    void listener(request, response);
  });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!isWebSocketUpgrade(request)) return void socket.destroy();
    clientAddress(request);
    webSocketUpgrade(request, socket, head);
  });
  return server;
}

// Stops the server for a host's SIGTERM: no new connections, every relay closing with its reconnect code
// (@clutchbox/server/shutdown) so its client comes back to another instance, and requests in flight let finish. Exits
// once the last connection ends, or after graceMs regardless.
export function shutDown(
  server: Server,
  { graceMs, exit = process.exit }: { graceMs: number; exit?: (code: number) => void },
) {
  beginShutdown();
  const done = () => {
    clearTimeout(timeout);
    clearInterval(idle);
    exit(0);
  };
  const timeout = setTimeout(done, graceMs);
  // close() ends only the keep-alive connections idle at that moment; one whose request finishes later would wait out
  // its keep-alive timeout, so idle ones are closed as they appear.
  const idle = setInterval(() => server.closeIdleConnections(), 100);
  server.close(done);
}

// Serves until a host's stop or a deploy sends SIGTERM, then shuts down (shutDown); a second signal exits at once. As
// the container's first process, Node gets no default handling of these signals.
export function listenUntilStopped(
  server: Server,
  { hostname, port, graceMs }: { hostname: string; port: number; graceMs: number },
) {
  server.listen(port, hostname, () => console.log(`Listening on http://${hostname}:${port}`));
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      if (stopping) process.exit(0);
      stopping = true;
      shutDown(server, { graceMs });
    });
}
