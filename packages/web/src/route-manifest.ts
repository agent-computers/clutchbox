import {
  CDP_MAX_DURATION_MS,
  LIVE_VIEW_MAX_DURATION_MS,
  ROUTE_MAX_DURATION_MS,
} from '@clutchbox/server/computer-timing';

// Every product URL, as the thin route file each app commits for it. Next.js routes only files in an app's own app/,
// and reads segment config (runtime, dynamic, maxDuration) only as literals written in that file: a re-exported
// maxDuration silently falls back to the platform default. So scripts/generate-routes.ts writes each file from this
// list, with the literals, and checks that they still match. Add or change a product route here, then run it.

// Segment config, written into the route file as literals.
export type Segment = { runtime?: 'nodejs'; dynamic?: 'force-dynamic'; maxDuration?: number };

export type RouteEntry = {
  // Names the route for messages and for --group, which places it in one of the app's route groups.
  id: string;
  // Its directory under app/, in Next.js segment syntax, outside any route group.
  dir: string;
  file: 'page.tsx' | 'layout.tsx' | 'route.ts';
  // Its module, @clutchbox/web/routes/<module>.
  module: string;
  // Exports of the module the file passes on unchanged.
  reexport?: string[];
  // An export of the module that takes the deployment's wiring (a route handler its getServices, a page or layout its
  // pageApi; with shell, its shell extras too) and returns the handler or component, exported under each name in `as`.
  factory?: { name: string; as: string[]; shell?: true };
  // Other exports of the module, exported under another name: { OPTIONS: 'authPreflight' }.
  aliases?: Record<string, string>;
  segment?: Segment;
};

const server = { runtime: 'nodejs', dynamic: 'force-dynamic' } as const;
const seconds = (ms: number) => ms / 1000;

export const routeManifest: RouteEntry[] = [
  {
    id: 'sign-in',
    dir: 'sign-in',
    file: 'page.tsx',
    module: 'sign-in',
    reexport: ['metadata'],
    factory: { name: 'signInPage', as: ['default'] },
  },
  {
    id: 'consent',
    dir: 'consent',
    file: 'page.tsx',
    module: 'consent',
    reexport: ['metadata'],
    factory: { name: 'consentPage', as: ['default'] },
    segment: { dynamic: 'force-dynamic' },
  },
  {
    id: 'connect',
    dir: 'connect',
    file: 'page.tsx',
    module: 'connect',
    reexport: ['metadata'],
    factory: { name: 'connectPage', as: ['default'] },
    segment: { dynamic: 'force-dynamic' },
  },
  {
    id: 'app-layout',
    dir: 'app',
    file: 'layout.tsx',
    module: 'app-layout',
    reexport: ['metadata'],
    factory: { name: 'appLayout', as: ['default'], shell: true },
    segment: { dynamic: 'force-dynamic' },
  },
  { id: 'overview', dir: 'app', file: 'page.tsx', module: 'overview', reexport: ['default', 'metadata'] },
  { id: 'agents', dir: 'app/agents', file: 'page.tsx', module: 'agents', reexport: ['default', 'metadata'] },
  { id: 'computer', dir: 'app/computer', file: 'page.tsx', module: 'computer', reexport: ['default', 'metadata'] },
  { id: 'sync', dir: 'app/sync', file: 'page.tsx', module: 'sync', reexport: ['default', 'metadata'] },
  {
    id: 'settings',
    dir: 'app/settings',
    file: 'page.tsx',
    module: 'settings',
    reexport: ['metadata'],
    factory: { name: 'settingsPage', as: ['default'] },
  },
  {
    id: 'developers',
    dir: 'app/developers',
    file: 'page.tsx',
    module: 'developers',
    reexport: ['default', 'metadata'],
  },
  {
    id: 'organization',
    dir: 'app/organization',
    file: 'page.tsx',
    module: 'organization',
    reexport: ['default', 'metadata'],
  },
  {
    id: 'join',
    dir: 'join',
    file: 'page.tsx',
    module: 'join',
    reexport: ['metadata'],
    factory: { name: 'joinPage', as: ['default'] },
    segment: { dynamic: 'force-dynamic' },
  },
  {
    id: 'invitation',
    dir: 'join/[invitation]',
    file: 'page.tsx',
    module: 'join',
    reexport: ['metadata'],
    factory: { name: 'invitationPage', as: ['default'] },
    segment: { dynamic: 'force-dynamic' },
  },
  {
    id: 'auth',
    dir: 'api/auth/[...all]',
    file: 'route.ts',
    module: 'auth',
    factory: { name: 'authRoute', as: ['GET', 'POST'] },
    aliases: { OPTIONS: 'authPreflight' },
    segment: server,
  },
  {
    id: 'well-known',
    dir: '.well-known/[...path]',
    file: 'route.ts',
    module: 'well-known',
    factory: { name: 'wellKnownRoute', as: ['GET'] },
    segment: server,
  },
  {
    id: 'health',
    dir: 'api/health',
    file: 'route.ts',
    module: 'health',
    factory: { name: 'healthRoute', as: ['GET'] },
    segment: server,
  },
  {
    // One tool call runs inside this limit (CALL_BUDGET_MS is derived from it).
    id: 'mcp',
    dir: 'api/mcp',
    file: 'route.ts',
    module: 'mcp',
    factory: { name: 'mcpRoute', as: ['POST', 'GET', 'DELETE'] },
    segment: { ...server, maxDuration: seconds(ROUTE_MAX_DURATION_MS) },
  },
  {
    // The same limit as an MCP call: the API also resets and deletes computers and takes over control.
    id: 'api',
    dir: 'api/v1/[[...route]]',
    file: 'route.ts',
    module: 'api',
    factory: { name: 'apiRoute', as: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] },
    segment: { ...server, maxDuration: seconds(ROUTE_MAX_DURATION_MS) },
  },
  {
    // Its own route, which takes precedence over the API's catch-all, for its own limit: the relay closes the
    // connection just before it, and the page reconnects.
    id: 'live-view',
    dir: 'api/v1/live-view',
    file: 'route.ts',
    module: 'live-view',
    factory: { name: 'liveViewRoute', as: ['GET'] },
    segment: { ...server, maxDuration: seconds(LIVE_VIEW_MAX_DURATION_MS) },
  },
  {
    // The CDP proxy, likewise: it closes the connection just before its limit, and the client reconnects.
    id: 'cdp',
    dir: 'api/v1/cdp',
    file: 'route.ts',
    module: 'cdp',
    factory: { name: 'cdpRoute', as: ['GET'] },
    segment: { ...server, maxDuration: seconds(CDP_MAX_DURATION_MS) },
  },
  {
    id: 'extension-client',
    dir: 'oauth/extension-client.json',
    file: 'route.ts',
    module: 'extension-client',
    reexport: ['GET'],
    segment: server,
  },
  {
    id: 'extension-download',
    dir: 'downloads/agent-computers-extension.zip',
    file: 'route.ts',
    module: 'extension-download',
    reexport: ['GET'],
  },
];
