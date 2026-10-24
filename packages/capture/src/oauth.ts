import { z } from 'zod';

// The extension's OAuth client of its own server: PKCE, no consent page, opaque `sync` tokens. Pure
// functions with an injected fetch, so the extension and servers' contract tests run the same code.

// A plain name, not a URL, so a server that registers clients from their metadata URL never tries to fetch it.
export const extensionClientId = 'agent-computers-extension';
export const syncScope = 'sync';
// How long the server gives a rotated refresh token the same answer. A rotated token presented after it counts as
// theft: the server disconnects that browser and deletes the copy it uploaded.
export const refreshReuseSeconds = 30;

// Protocol timings tied to the server, not tunables: they must hold before any config has been fetched.
// A connect flow stays usable this long, which covers signing in with Google in the tab.
export const flowTtlMs = 15 * 60_000;
// Refresh this long before the 5-minute access token expires.
export const refreshAheadMs = 60_000;
// Each refresh attempt's timeout.
export const refreshAttemptMs = 15_000;
// No refresh attempt starts after this.
export const refreshRetryMs = 20_000;
// Every attempt is aborted by then, so a retry of a rotation whose response was lost reaches the server inside the
// reuse window and gets the same answer. If none succeeds in time, the next refresh replays the old token after the
// window: the server then disconnects this browser and deletes the copy it uploaded, and the extension shows
// Reconnect.
export const refreshDeadlineMs = (refreshReuseSeconds - 3) * 1000;

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export const s256 = async (verifier: string) =>
  base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
export async function pkce() {
  const verifier = random();
  return { verifier, challenge: await s256(verifier) };
}
export const newState = random;
export const issuerOf = (server: string) => `${server}/api/auth`;

// No `prompt` (the server refuses prompt=consent for the extension) and no `resource`, so the token is opaque.
export function authorizeUrl(
  server: string,
  redirectUri: string,
  { state, challenge }: { state: string; challenge: string },
) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: extensionClientId,
    redirect_uri: redirectUri,
    scope: `offline_access ${syncScope}`,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${issuerOf(server)}/oauth2/authorize?${params}`;
}

export type Redirect = { state: string; iss?: string } & ({ code: string } | { error: string });
// The authorization response on the redirect page, or null. Exactly one of code and error, and no repeated parameter.
export function readRedirect(url: string, redirectUri: string): Redirect | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // `origin` is "null" for chrome-extension: URLs outside Chrome.
  if (`${parsed.protocol}//${parsed.host}${parsed.pathname}` !== redirectUri) return null;
  const params = parsed.searchParams;
  const one = (name: string) => {
    const values = params.getAll(name);
    return values.length > 1 ? null : values[0];
  };
  const [code, error, state, iss] = ['code', 'error', 'state', 'iss'].map(one);
  if (code === null || error === null || state === null || iss === null || !state) return null;
  if ((code === undefined) === (error === undefined)) return null;
  return { state, ...(iss === undefined ? {} : { iss }), ...(code !== undefined ? { code } : { error: error! }) };
}

export type TokenGrant = { code: string; verifier: string; redirectUri: string } | { refreshToken: string };
export function tokenForm(grant: TokenGrant) {
  return new URLSearchParams(
    'refreshToken' in grant
      ? { grant_type: 'refresh_token', client_id: extensionClientId, refresh_token: grant.refreshToken }
      : {
          grant_type: 'authorization_code',
          client_id: extensionClientId,
          code: grant.code,
          code_verifier: grant.verifier,
          redirect_uri: grant.redirectUri,
        },
  );
}

export const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(2048),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).max(2048),
  scope: z.string().refine(scope => scope.split(' ').includes(syncScope)),
});
export type SyncTokens = { access: string; refresh: string; expiresAt: number };
// `invalid_grant`: the server refused the code or refresh token. `retry`: the outcome is unknown (network, timeout,
// 5xx), so the server may have rotated the token. `unavailable`: refused for another reason (429, other 4xx, a body
// that isn't tokens); the tokens it was sent stay good.
export type TokenResult = { tokens: SyncTokens } | 'invalid_grant' | 'retry' | 'unavailable';
export async function readTokenResponse(response: Response, now = Date.now()): Promise<TokenResult> {
  if (response.status >= 500) return 'retry';
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // An aborted read leaves the outcome unknown; anything else is not tokens.
    return response.ok ? 'retry' : 'unavailable';
  }
  if (response.ok) {
    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success) return 'unavailable';
    const { access_token, refresh_token, expires_in } = parsed.data;
    return { tokens: { access: access_token, refresh: refresh_token, expiresAt: now + expires_in * 1000 } };
  }
  const error = (body as { error?: unknown } | null)?.error;
  return (response.status === 400 || response.status === 401) && error === 'invalid_grant'
    ? 'invalid_grant'
    : 'unavailable';
}
// POSTs a grant to the token endpoint, never with cookies: the extension holds no grant on our site, so credentialed
// CORS would fail, and the server refuses a cookie there.
export async function requestTokens(
  fetcher: typeof fetch,
  server: string,
  grant: TokenGrant,
  signal?: AbortSignal,
): Promise<TokenResult> {
  try {
    const response = await fetcher(`${issuerOf(server)}/oauth2/token`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenForm(grant).toString(),
      ...(signal ? { signal } : {}),
    });
    return await readTokenResponse(response);
  } catch {
    return 'retry';
  }
}
// A timeout signal driven by setTimeout, which tests' fake timers control (AbortSignal.timeout is not).
export function timeoutSignal(ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), Math.max(ms, 0));
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
