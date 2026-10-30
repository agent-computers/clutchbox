import { type ClientAddress, clientAddressFromEnv, listenUntilStopped, nodeServer } from '@clutchbox/api/node-upgrade';
import { SHUTDOWN_GRACE_MS } from '@clutchbox/server/computer-timing';
import { getRequestListener } from '@hono/node-server';
import { securityHeaders } from '../next-config.mjs';
import { type RouteEntry, routeManifest } from './route-manifest';
import * as api from './routes/api';
import * as auth from './routes/auth';
import * as cdp from './routes/cdp';
import * as extensionClient from './routes/extension-client';
import * as health from './routes/health';
import * as liveView from './routes/live-view';
import * as mcp from './routes/mcp';
import * as wellKnown from './routes/well-known';
import type { GetServices } from './services';

// The API's own server, apart from the web app and without Next.js: the route manifest's route files for the API,
// sign-in (Better Auth), MCP, both relays, the auth server's discovery documents, and the extension's OAuth client,
// answered as Next.js answers them. In front of it, a reverse proxy or the host's routing sends these paths here and
// the rest to the web app, which keeps the extension download it builds.
const API_DIRS = ['api/', '.well-known/', 'oauth/'];
export const apiRoutes = routeManifest.filter(
  entry => entry.file === 'route.ts' && API_DIRS.some(dir => entry.dir.startsWith(dir)),
);
const modules: Record<string, Record<string, unknown>> = {
  api,
  auth,
  cdp,
  'extension-client': extensionClient,
  health,
  'live-view': liveView,
  mcp,
  'well-known': wellKnown,
};

type Handler = (request: Request) => Response | Promise<Response>;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

// Whether a path, as its segments, is a route's: Next.js segment syntax, with a name, [param], [...rest] (one or
// more), and [[...rest]] (none or more), the last two only at the end.
function matcher(dir: string) {
  const segments = dir.split('/');
  return (path: string[]) => {
    for (const [i, segment] of segments.entries()) {
      if (segment.startsWith('[[...')) return true;
      if (segment.startsWith('[...')) return path.length > i;
      if (i >= path.length || (!segment.startsWith('[') && segment !== path[i])) return false;
    }
    return path.length === segments.length;
  };
}

// A route's handler for each method, as its route file exports them (route-manifest.ts, RouteEntry).
function handlers(entry: RouteEntry, getServices: GetServices) {
  const module = modules[entry.module];
  if (!module) throw new Error(`The API server has no module for the ${entry.id} route.`);
  const byMethod: Record<string, Handler> = {};
  if (entry.factory) {
    const handler = (module[entry.factory.name] as (getServices: GetServices) => Handler)(getServices);
    for (const method of entry.factory.as) byMethod[method] = handler;
  }
  for (const name of entry.reexport ?? []) if (METHODS.includes(name)) byMethod[name] = module[name] as Handler;
  for (const [method, name] of Object.entries(entry.aliases ?? {})) byMethod[method] = module[name] as Handler;
  return byMethod;
}

// The headers Next.js adds to every response (next-config.mjs), on a copy when the response's own are immutable, as a
// redirect's are.
function withSecurityHeaders(response: Response) {
  const missing = securityHeaders.filter(({ key }) => !response.headers.has(key));
  if (!missing.length) return response;
  let answer = response;
  try {
    for (const { key, value } of missing) answer.headers.set(key, value);
  } catch {
    answer = new Response(response.body, response);
    for (const { key, value } of missing) answer.headers.set(key, value);
  }
  return answer;
}

// Every API route's requests, as one handler. Like Next.js, a path tries named segments before dynamic ones, HEAD
// runs GET without its body, OPTIONS without a handler of its own answers with the methods allowed, and every
// response carries the security headers.
export function apiHandler(getServices: GetServices): Handler {
  const handle = route(getServices);
  return async request => withSecurityHeaders(await handle(request));
}

function route(getServices: GetServices): Handler {
  const routes = apiRoutes
    .map(entry => ({ entry, matches: matcher(entry.dir), byMethod: handlers(entry, getServices) }))
    .sort((a, b) => Number(a.entry.dir.includes('[')) - Number(b.entry.dir.includes('[')));
  return async request => {
    const path = new URL(request.url).pathname.split('/').filter(Boolean);
    const route = routes.find(candidate => candidate.matches(path));
    if (!route) return Response.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const { byMethod } = route;
    const handler = byMethod[request.method];
    if (handler) return handler(request);
    if (request.method === 'HEAD' && byMethod.GET) {
      const { status, statusText, headers } = await byMethod.GET(request);
      return new Response(null, { status, statusText, headers });
    }
    const allowed = [...Object.keys(byMethod), ...(byMethod.GET ? ['HEAD'] : []), 'OPTIONS'];
    const allow = { Allow: [...new Set(allowed)].join(', ') };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: allow });
    return new Response(null, { status: 405, headers: allow });
  };
}

// The API's HTTP server: apiHandler on the Node server that also runs WebSocket upgrades through it
// (@clutchbox/api/node-upgrade). The adapter leaves the global Request and Response alone, so Better Auth and the
// MCP SDK see the platform's own.
export function apiServer(getServices: GetServices, clientAddress: ClientAddress = {}) {
  return nodeServer(getRequestListener(apiHandler(getServices), { overrideGlobalObjects: false }), clientAddress);
}

// An app's API server, as its api.ts runs it: `node --conditions=react-server --import tsx api.ts`, with its
// services and its migration. HOST, PORT, MIGRATE_ON_START, and the client address (TRUST_PROXY, CLIENT_IP_HEADER,
// FORWARDED_SECRET) work as for the whole app's server (node-server.ts), and it stops the same way.
export async function startApiServer({
  getServices,
  migrate,
}: {
  getServices: GetServices;
  migrate: () => Promise<boolean>;
}) {
  if (process.env.MIGRATE_ON_START === 'true' && !(await migrate())) process.exit(1);
  const server = apiServer(getServices, clientAddressFromEnv());
  const hostname = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 3000);
  listenUntilStopped(server, { hostname, port, graceMs: SHUTDOWN_GRACE_MS });
}
