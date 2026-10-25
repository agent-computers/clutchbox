import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

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

// The web app's HTTP server off Vercel: every request, and every WebSocket handshake, goes to the framework's listener.
// Other upgrades (h2c) are refused: no route answers one, and an unanswered upgrade would hold its socket open.
//
// Better Auth keys its rate limits on X-Forwarded-For, which Vercel overwrites with the client's IP and Next.js fills
// only when it is missing, so a client reaching this server directly could send a fresh one per request and never be
// limited. So it is set to the connection's own address, unless trustProxy says a reverse proxy in front overwrites
// it with the client's (one that appends to it would let clients choose again).
export function nodeServer(listener: RequestListener, { trustProxy = false } = {}) {
  const clientAddress = (request: IncomingMessage) => {
    if (!trustProxy) request.headers['x-forwarded-for'] = request.socket.remoteAddress ?? '';
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
