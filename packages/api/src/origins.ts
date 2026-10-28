import { extensionOrigins } from '@clutchbox/server/browsers';

export { extensionOrigins };
// The extension's routes: a sync token works only here, and mutations here also accept the pinned extension
// origins (EXTENSION_ORIGINS). Every other mutation comes from the web origin.
export const SYNC_PATHS = ['/api/v1/me', '/api/v1/captures', '/api/v1/sync', '/api/v1/sync/adopt'];
const TOKEN_PATH = '/api/auth/oauth2/token';
export const isPinnedExtension = (origin: string | null | undefined, pinned: string | undefined) =>
  !!origin && extensionOrigins(pinned).includes(origin);
export function allowedMutationOrigin(
  origin: string | undefined,
  path: string,
  webOrigin: string,
  pinned: string | undefined,
) {
  if (!origin) return false;
  if (origin === webOrigin) return true;
  return SYNC_PATHS.includes(path) && isPinnedExtension(origin, pinned);
}

// CORS for the pinned extension origins on the extension's routes only; never with credentials. The API answers its own
// (index.ts); this covers what reaches the extension outside it: the token endpoint, and 503s from the Next routes.
export function extensionCors(request: Request, response: Response, pinned = process.env.EXTENSION_ORIGINS) {
  const path = new URL(request.url).pathname;
  const origin = request.headers.get('origin');
  if (!(SYNC_PATHS.includes(path) || path === TOKEN_PATH) || !isPinnedExtension(origin, pinned)) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin!);
  headers.append('Vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
// Preflights on the auth routes: only the token endpoint answers one, and only a pinned origin gets CORS headers.
export function tokenPreflight(request: Request, pinned = process.env.EXTENSION_ORIGINS) {
  if (new URL(request.url).pathname !== TOKEN_PATH)
    return new Response(null, { status: 405, headers: { Allow: 'GET, POST', 'Cache-Control': 'no-store' } });
  return extensionCors(
    request,
    new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Max-Age': '600',
        'Cache-Control': 'no-store',
      },
    }),
    pinned,
  );
}
