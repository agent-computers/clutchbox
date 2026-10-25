import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Auth } from './auth';
import { EXTENSION_CLIENT_ID } from './browsers';

// Connects a synthetic browser through the real OAuth flow, for tests only.
export const CHROME_ON_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
export const EDGE_ON_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
export type Tokens = { access_token: string; refresh_token: string; scope: string; expires_in: number };

const originOf = async (auth: Auth) => new URL((await auth.$context).baseURL).origin;
// The authorize request the extension makes from our web app's tab, signed in with `cookie`.
export async function authorizeBrowser(
  auth: Auth,
  cookie: string,
  { extensionOrigin, query = {} }: { extensionOrigin: string; query?: Record<string, string | undefined> },
) {
  const verifier = randomBytes(48).toString('base64url');
  const params = new URLSearchParams();
  const defaults = {
    client_id: EXTENSION_CLIENT_ID,
    redirect_uri: `${extensionOrigin}/connected.html`,
    response_type: 'code',
    scope: 'offline_access sync',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: randomUUID(),
  };
  for (const [key, value] of Object.entries({ ...defaults, ...query })) if (value !== undefined) params.set(key, value);
  const response = await auth.handler(
    new Request(`${await originOf(auth)}/api/auth/oauth2/authorize?${params}`, { headers: { cookie } }),
  );
  return { response, verifier };
}
// The extension's cookie-free token request from its own origin.
export async function tokenRequest(
  auth: Auth,
  extensionOrigin: string,
  body: Record<string, string>,
  userAgent = CHROME_ON_MAC,
) {
  return auth.handler(
    new Request(`${await originOf(auth)}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: {
        origin: extensionOrigin,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': userAgent,
      },
      body: new URLSearchParams({ client_id: EXTENSION_CLIENT_ID, ...body }).toString(),
    }),
  );
}
// Authorize straight to the extension page (no consent page), then exchange the code.
export async function connectBrowser(
  auth: Auth,
  cookie: string,
  { extensionOrigin, userAgent }: { extensionOrigin: string; userAgent?: string },
) {
  const { response, verifier } = await authorizeBrowser(auth, cookie, { extensionOrigin });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!);
  expect(`${location.protocol}//${location.host}${location.pathname}`).toBe(`${extensionOrigin}/connected.html`);
  const code = location.searchParams.get('code');
  expect(code).toBeTruthy();
  const exchanged = await tokenRequest(
    auth,
    extensionOrigin,
    {
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: verifier,
      redirect_uri: `${extensionOrigin}/connected.html`,
    },
    userAgent,
  );
  expect(exchanged.status).toBe(200);
  return (await exchanged.json()) as Tokens;
}
export const refreshBrowser = (auth: Auth, extensionOrigin: string, refreshToken: string, extra = {}) =>
  tokenRequest(auth, extensionOrigin, { grant_type: 'refresh_token', refresh_token: refreshToken, ...extra });
