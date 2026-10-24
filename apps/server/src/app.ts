import { timingSafeEqual } from 'node:crypto';
import {
  applySyncChange,
  type Capture,
  captureDigest,
  captureSchema,
  defaultExtensionConfig,
  extensionClientId,
  extensionVersionHeader,
  issuerOf,
  narrowCapture,
  refreshReuseSeconds,
  type SyncSettings,
  s256,
  siteOfHost,
  syncChangeSchema,
  syncScope,
  syncSettingsSchema,
} from '@agent-computers/capture';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { Config } from './config';
import { hashToken, open, randomToken, type State, type Store, seal } from './store';

// The extension's server contract (its OAuth client in @agent-computers/capture, and the sync routes it calls), for one
// owner who connects browsers with an access key instead of an account. Agents read the latest capture with the API key.
export const ACCESS_TOKEN_SECONDS = 5 * 60;
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 3600;
const CODE_SECONDS = 60;
// The extension's own upload cap (maxUploadBytes).
const MAX_CAPTURE_BYTES = 4_000_000;
const SYNC_PATHS = ['/api/v1/me', '/api/v1/captures', '/api/v1/sync', '/api/v1/sync/adopt'];

type Env = { Variables: { browserId: string } };
type Code = { challenge: string; redirectUri: string; expiresAt: number };
type TokenBody = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
};

const sameSecret = (given: string, expected: string) => {
  const [a, b] = [hashToken(given), hashToken(expected)].map(value => Buffer.from(value));
  return timingSafeEqual(a!, b!);
};
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const authorizeSchema = z.object({
  response_type: z.literal('code'),
  client_id: z.literal(extensionClientId),
  redirect_uri: z.string().max(200),
  scope: z.string().refine(scope => scope.split(' ').includes(syncScope)),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal('S256'),
  state: z.string().min(1).max(512),
});
type Authorize = z.infer<typeof authorizeSchema>;

export function createApp(config: Config, store: Store, now: () => number = Date.now) {
  const issuer = issuerOf(config.PUBLIC_URL);
  const serverSite = siteOfHost(new URL(config.PUBLIC_URL).hostname);
  const redirectUris = config.EXTENSION_ORIGINS.map(origin => `${origin}/connected.html`);
  const isExtension = (origin: string | undefined) => !!origin && config.EXTENSION_ORIGINS.includes(origin);
  // Single-use authorization codes, and the answer to each rotated refresh token for the reuse window. Memory only:
  // a restart costs an in-flight connect or a retried refresh, never a stored secret.
  const codes = new Map<string, Code>();
  const rotations = new Map<string, { body: TokenBody; until: number }>();

  const settingsOf = (state: State): SyncSettings | null =>
    state.settings
      ? syncSettingsSchema.parse(JSON.parse(open(state.settings, 'settings', config.CAPTURE_ENCRYPTION_KEY)))
      : null;
  const captureOf = (state: State): Capture | null =>
    state.capture
      ? captureSchema.parse(JSON.parse(open(state.capture.sealed, 'capture', config.CAPTURE_ENCRYPTION_KEY)))
      : null;
  const storeCapture = (state: State, capture: Capture, digest: string, browserId: string | null) => {
    const completedAt = new Date(Math.min(Date.parse(capture.completedAt), now())).toISOString();
    state.capture = {
      sealed: seal(JSON.stringify(capture), 'capture', config.CAPTURE_ENCRYPTION_KEY),
      digest,
      completedAt,
      cookieCount: capture.cookies.length,
      browserId,
    };
  };
  // Saves settings and narrows the stored capture to them, so a removed site or a new exclusion leaves it at once.
  const saveSettings = async (settings: SyncSettings) => {
    const current = store.read();
    const capture = captureOf(current);
    const narrowed = capture ? narrowCapture(capture, settings) : null;
    const digest = narrowed ? await captureDigest(narrowed.cookies) : null;
    await store.update(state => {
      state.settings = seal(JSON.stringify(settings), 'settings', config.CAPTURE_ENCRYPTION_KEY);
      if (narrowed && state.capture && digest !== state.capture.digest)
        state.capture = {
          ...state.capture,
          sealed: seal(JSON.stringify(narrowed), 'capture', config.CAPTURE_ENCRYPTION_KEY),
          digest: digest!,
          cookieCount: narrowed.cookies.length,
        };
    });
  };
  const issueTokens = (state: State, browserId: string): TokenBody => {
    const [access, refresh] = [randomToken(), randomToken()];
    state.tokens[hashToken(access)] = { kind: 'access', browserId, expiresAt: now() + ACCESS_TOKEN_SECONDS * 1000 };
    state.tokens[hashToken(refresh)] = { kind: 'refresh', browserId, expiresAt: now() + REFRESH_TOKEN_SECONDS * 1000 };
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refresh,
      scope: `offline_access ${syncScope}`,
    };
  };
  // Disconnects a browser: its tokens go, and the stored capture too if this browser sent it.
  const disconnect = (state: State, browserId: string) => {
    delete state.browsers[browserId];
    for (const [hash, token] of Object.entries(state.tokens))
      if (token.browserId === browserId) delete state.tokens[hash];
    if (state.capture?.browserId === browserId) state.capture = undefined;
  };

  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  // --- OAuth for the extension: PKCE, no consent page, opaque tokens ---
  const page = (c: Context<Env>, params: Authorize, error?: string) => {
    c.header('X-Frame-Options', 'DENY');
    // The form's redirect goes to the extension, so it is allowed as a form action.
    c.header(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${config.EXTENSION_ORIGINS.join(' ')}; frame-ancestors 'none'`,
    );
    const hidden = Object.entries(params)
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join('');
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect this browser</title>
<style>body{font:16px system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;background:#0d060b;color:#fff}input[type=password]{width:100%;padding:.6rem;margin:.5rem 0 1rem;box-sizing:border-box}button{padding:.6rem 1rem;background:#ff488b;border:0;color:#0d060b;font-weight:600}p.error{color:#ff9e7a}</style></head>
<body><h1>Connect this browser</h1><p>Its extension will sync the sites you choose to ${escapeHtml(config.PUBLIC_URL)}.</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post">${hidden}<label>Access key<input type="password" name="access_key" autocomplete="current-password" required autofocus></label><button type="submit">Connect</button></form></body></html>`,
      error ? 401 : 200,
    );
  };
  const readAuthorize = (input: Record<string, unknown>) => {
    if ('prompt' in input) return null;
    const parsed = authorizeSchema.safeParse(input);
    return parsed.success && redirectUris.includes(parsed.data.redirect_uri) ? parsed.data : null;
  };
  app.get('/api/auth/oauth2/authorize', c => {
    const params = readAuthorize(c.req.query());
    if (!params) return c.text('Invalid authorization request.', 400);
    return page(c, params);
  });
  app.post('/api/auth/oauth2/authorize', async c => {
    const form = (await c.req.parseBody()) as Record<string, string>;
    const { access_key: key, ...rest } = form;
    const params = readAuthorize(rest);
    if (!params) return c.text('Invalid authorization request.', 400);
    if (typeof key !== 'string' || !sameSecret(key, config.ACCESS_KEY)) {
      await new Promise(resolve => setTimeout(resolve, 500));
      return page(c, params, 'That access key is not right.');
    }
    const code = randomToken();
    codes.set(code, {
      challenge: params.code_challenge,
      redirectUri: params.redirect_uri,
      expiresAt: now() + CODE_SECONDS * 1000,
    });
    const target = new URL(params.redirect_uri);
    target.search = new URLSearchParams({ code, state: params.state, iss: issuer }).toString();
    return c.redirect(target.toString(), 302);
  });

  app.use(
    '/api/auth/oauth2/token',
    cors({ origin: from => (isExtension(from) ? from : null), allowMethods: ['POST'], allowHeaders: ['content-type'] }),
  );
  app.post('/api/auth/oauth2/token', async c => {
    const invalid = () => c.json({ error: 'invalid_grant' }, 400);
    const form = (await c.req.parseBody()) as Record<string, string>;
    if (form.client_id !== extensionClientId) return c.json({ error: 'invalid_client' }, 401);
    if (form.grant_type === 'authorization_code') {
      const stored = codes.get(form.code ?? '');
      codes.delete(form.code ?? '');
      if (!stored || stored.expiresAt < now() || stored.redirectUri !== form.redirect_uri) return invalid();
      if (!form.code_verifier || (await s256(form.code_verifier)) !== stored.challenge) return invalid();
      const body = await store.update(state => {
        const browserId = randomToken();
        state.browsers[browserId] = { createdAt: new Date(now()).toISOString() };
        return issueTokens(state, browserId);
      });
      return c.json(body);
    }
    if (form.grant_type === 'refresh_token' && form.refresh_token) {
      const hash = hashToken(form.refresh_token);
      // A retry of a rotation whose answer was lost gets the same answer within the window.
      const replay = rotations.get(hash);
      if (replay && replay.until > now()) return c.json(replay.body);
      const result = await store.update(state => {
        const token = state.tokens[hash];
        if (token?.kind !== 'refresh' || token.expiresAt <= now() || !state.browsers[token.browserId]) return null;
        // A rotated token replayed after the window counts as stolen: that browser is disconnected.
        if (token.rotatedAt !== undefined) {
          disconnect(state, token.browserId);
          return null;
        }
        // Kept until it would have expired, so a replay any time before then is caught.
        token.rotatedAt = now();
        return issueTokens(state, token.browserId);
      });
      if (!result) return invalid();
      rotations.set(hash, { body: result, until: now() + refreshReuseSeconds * 1000 });
      for (const [key, value] of rotations) if (value.until <= now()) rotations.delete(key);
      return c.json(result);
    }
    return c.json({ error: 'unsupported_grant_type' }, 400);
  });

  // --- The extension's sync routes ---
  const extensionCors = cors({
    origin: from => (isExtension(from) ? from : null),
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowHeaders: ['authorization', 'content-type', extensionVersionHeader],
    maxAge: 600,
  });
  for (const path of SYNC_PATHS) {
    app.use(path, extensionCors);
    app.use(path, async (c, next) => {
      const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(c.req.header('authorization') ?? '');
      const token = match ? store.read().tokens[hashToken(match[1]!)] : undefined;
      if (token?.kind !== 'access' || token.expiresAt <= now() || !store.read().browsers[token.browserId])
        return c.json({ error: 'unauthenticated' }, 401, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
      // A token alone isn't enough to change anything: the request must come from the extension.
      if (c.req.method !== 'GET' && !isExtension(c.req.header('origin')))
        return c.json({ error: 'forbidden_origin' }, 403);
      c.set('browserId', token.browserId);
      await next();
    });
  }
  app.get('/api/v1/me', c => c.json({ user: { id: 'owner', email: config.OWNER_EMAIL } }));
  app.get('/api/v1/sync', c =>
    c.json({ settings: settingsOf(store.read()), disconnected: false, config: defaultExtensionConfig }),
  );
  app.patch('/api/v1/sync', async c => {
    const change = syncChangeSchema.safeParse(await c.req.json().catch(() => null));
    if (!change.success) return c.json({ error: 'invalid_request' }, 400);
    const existing = settingsOf(store.read());
    if (!existing) return c.json({ error: 'sync_settings_missing' }, 409);
    const settings = applySyncChange(existing, change.data, serverSite);
    await saveSettings(settings);
    return c.json({ settings });
  });
  app.post('/api/v1/sync/adopt', async c => {
    const local = z
      .object({ settings: syncSettingsSchema })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!local.success) return c.json({ error: 'invalid_request' }, 400);
    const existing = settingsOf(store.read());
    if (existing) return c.json({ settings: existing });
    const settings = applySyncChange(local.data.settings, {}, serverSite);
    await saveSettings(settings);
    return c.json({ settings });
  });
  app.post(
    '/api/v1/captures',
    bodyLimit({ maxSize: MAX_CAPTURE_BYTES, onError: c => c.json({ error: 'capture_too_large' }, 413) }),
    async c => {
      const parsed = z
        .object({ capture: captureSchema, connect: z.literal(true).optional() })
        .strict()
        .safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
      const browserId = c.get('browserId');
      const settings = settingsOf(store.read());
      if (settings?.paused) return c.json({ error: 'sync_paused', settings }, 409);
      const capture = settings ? narrowCapture(parsed.data.capture, settings) : parsed.data.capture;
      const digest = await captureDigest(capture.cookies);
      const saved = await store.update(state => {
        const browser = state.browsers[browserId];
        if (!browser) return null;
        browser.lastSyncedAt = new Date(now()).toISOString();
        const unchanged = state.capture?.digest === digest;
        storeCapture(state, capture, digest, browserId);
        return { status: unchanged ? ('unchanged' as const) : ('stored' as const), stored: state.capture! };
      });
      if (!saved) return c.json({ error: 'sync_disconnected' }, 409);
      const { status, stored } = saved;
      return c.json({
        status,
        completedAt: stored.completedAt,
        cookieCount: stored.cookieCount,
        ...(settings ? { settings } : {}),
      });
    },
  );
  app.delete('/api/v1/captures', async c => {
    await store.update(state => disconnect(state, c.get('browserId')));
    return c.json({ deleted: true });
  });

  // --- For agents and computers: the latest capture, with the API key ---
  app.get('/api/v1/capture', c => {
    const match = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '');
    if (!match || !sameSecret(match[1]!, config.API_KEY)) return c.json({ error: 'unauthenticated' }, 401);
    const state = store.read();
    const capture = captureOf(state);
    if (!capture || !state.capture) return c.json({ error: 'no_capture' }, 404);
    return c.json({ digest: state.capture.digest, completedAt: state.capture.completedAt, capture });
  });

  // The extension links to account, privacy, and live view pages, which this server doesn't have.
  app.notFound(c =>
    c.req.method === 'GET' && !c.req.path.startsWith('/api/')
      ? c.html(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Self-hosted sync</title></head><body style="font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;background:#0d060b;color:#fff"><h1>Self-hosted sync</h1><p>This is a self-hosted Agent Computers sync server for ${escapeHtml(config.OWNER_EMAIL)}. It has no account pages: manage sites, pause, and disconnect from the extension.</p></body></html>`,
          404,
        )
      : c.json({ error: 'not_found' }, 404),
  );
  return app;
}
