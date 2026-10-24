import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  authorizeUrl,
  type Capture,
  type CapturedCookie,
  meSchema,
  newState,
  pkce,
  readRedirect,
  refreshReuseSeconds,
  requestTokens,
  type SyncTokens,
  syncResponseSchema,
  uploadResultSchema,
} from '@agent-computers/capture';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import { type Config, readConfig } from './config';
import { fileStore, memoryStore } from './store';

const extension = `chrome-extension://${'a'.repeat(32)}`;
const redirectUri = `${extension}/connected.html`;
const config: Config = {
  PUBLIC_URL: 'https://sync.example.test',
  EXTENSION_ORIGINS: [extension],
  ACCESS_KEY: 'correct horse battery staple',
  API_KEY: 'agent-api-key-0123456789',
  CAPTURE_ENCRYPTION_KEY: randomBytes(32),
  OWNER_EMAIL: 'owner@example.test',
  DATA_DIR: './data',
  PORT: 8787,
};
// Synthetic cookies only; no real browser data.
const cookie = (overrides: Partial<CapturedCookie> = {}): CapturedCookie => ({
  name: 'sid',
  value: 'secret-session-value',
  domain: 'github.com',
  hostOnly: true,
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  session: false,
  expirationDate: 2_000_000_000,
  storeId: '0',
  ...overrides,
});
const capture = (cookies: CapturedCookie[], sites = ['github.com', 'notion.so']): Capture => ({
  schemaVersion: 2,
  id: randomUUID(),
  scope: { mode: 'sites', sites, excludedDomains: [] },
  startedAt: new Date(Date.now() - 1000).toISOString(),
  completedAt: new Date().toISOString(),
  consistency: 'non-atomic-cookie-read',
  coverage: 'cookies-only',
  storeId: '0',
  cookies,
});

function setup(store = memoryStore()) {
  const clock = { now: Date.now() };
  const app = createApp(config, store, () => clock.now);
  const fetcher = ((input: string | URL | Request, init?: RequestInit) =>
    app.request(input instanceof Request ? input : String(input), init)) as typeof fetch;
  // The extension's connect flow, with the functions it runs: authorize, enter the key, exchange the code.
  async function connect(key = config.ACCESS_KEY) {
    const { verifier, challenge } = await pkce();
    const state = newState();
    const url = authorizeUrl(config.PUBLIC_URL, redirectUri, { state, challenge });
    const form = new URLSearchParams([...new URL(url).searchParams, ['access_key', key]]);
    const response = await app.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (response.status !== 302) return { response };
    const redirect = readRedirect(response.headers.get('location')!, redirectUri);
    if (!redirect || !('code' in redirect)) throw new Error('no code');
    expect(redirect).toMatchObject({ state, iss: `${config.PUBLIC_URL}/api/auth` });
    const result = await requestTokens(fetcher, config.PUBLIC_URL, {
      code: redirect.code,
      verifier,
      redirectUri,
    });
    if (typeof result === 'string') throw new Error(result);
    return { response, tokens: result.tokens, code: redirect.code, verifier };
  }
  const api = (tokens: SyncTokens, pathname: string, init: RequestInit = {}) =>
    app.request(`${config.PUBLIC_URL}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${tokens.access}`,
        origin: extension,
        'content-type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  const latest = (key = config.API_KEY) =>
    app.request(`${config.PUBLIC_URL}/api/v1/capture`, { headers: { authorization: `Bearer ${key}` } });
  return { app, clock, fetcher, connect, api, latest };
}

describe('connecting a browser', () => {
  it('shows the connect page only for the extension, and refuses a wrong key', async () => {
    const { app, connect } = setup();
    const { challenge } = await pkce();
    const good = authorizeUrl(config.PUBLIC_URL, redirectUri, { state: 's', challenge });
    const page = await app.request(good);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('name="access_key"');
    const other = authorizeUrl(config.PUBLIC_URL, `chrome-extension://${'b'.repeat(32)}/connected.html`, {
      state: 's',
      challenge,
    });
    expect((await app.request(other)).status).toBe(400);
    expect((await app.request(`${good}&prompt=consent`)).status).toBe(400);
    const { response } = await connect('wrong key, but long enough');
    expect(response.status).toBe(401);
  });
  it('refuses key guesses past ten a minute, the right key included, then accepts it again', async () => {
    const { connect, latest, clock } = setup();
    for (let i = 0; i < 10; i++) expect((await latest(`wrong api key number ${i}`)).status).toBe(401);
    expect((await connect()).response.status).toBe(429);
    expect((await latest()).status).toBe(429);
    clock.now += 61_000;
    expect((await connect()).tokens).toBeDefined();
  });
  it('refuses an oversized connect form before reading it', async () => {
    const { app } = setup();
    const response = await app.request(`${config.PUBLIC_URL}/api/auth/oauth2/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `access_key=${'a'.repeat(20_000)}`,
    });
    expect(response.status).toBe(413);
  });
  it('exchanges a code once, and only with its verifier', async () => {
    const { connect, fetcher } = setup();
    const { tokens, code, verifier } = await connect();
    expect(tokens!.access).toBeTruthy();
    expect(await requestTokens(fetcher, config.PUBLIC_URL, { code: code!, verifier: verifier!, redirectUri })).toBe(
      'invalid_grant',
    );
  });
});

describe('syncing', () => {
  it('adopts settings, stores uploads sealed, and serves the latest capture to agents', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'self-host-'));
    const { connect, api, latest } = setup(await fileStore(dir));
    const { tokens } = await connect();
    // Every answer parses with the schemas the extension reads it with.
    expect(meSchema.parse(await (await api(tokens!, '/api/v1/me')).json()).user.email).toBe(config.OWNER_EMAIL);
    expect(syncResponseSchema.parse(await (await api(tokens!, '/api/v1/sync')).json()).settings).toBeNull();
    const adopted = await api(tokens!, '/api/v1/sync/adopt', {
      method: 'POST',
      body: JSON.stringify({ settings: { sites: ['github.com', 'notion.so'], excludedDomains: [], paused: false } }),
    });
    expect(await adopted.json()).toEqual({
      settings: { sites: ['github.com', 'notion.so'], excludedDomains: [], paused: false },
    });
    const body = JSON.stringify({ capture: capture([cookie(), cookie({ domain: 'notion.so' })]) });
    const stored = await api(tokens!, '/api/v1/captures', { method: 'POST', body });
    expect(uploadResultSchema.parse(await stored.json())).toMatchObject({ status: 'stored', cookieCount: 2 });
    expect(await (await api(tokens!, '/api/v1/captures', { method: 'POST', body })).json()).toMatchObject({
      status: 'unchanged',
    });
    expect(await readFile(path.join(dir, 'state.json'), 'utf8')).not.toContain('secret-session-value');
    expect((await latest('not the api key at all')).status).toBe(401);
    expect((await (await latest()).json()).capture.cookies).toHaveLength(2);
    // Removing a site narrows what is stored at once.
    await api(tokens!, '/api/v1/sync', { method: 'PATCH', body: JSON.stringify({ removeSites: ['notion.so'] }) });
    expect((await (await latest()).json()).capture.cookies.map((c: CapturedCookie) => c.domain)).toEqual([
      'github.com',
    ]);
    // A restart keeps it all.
    const restarted = setup(await fileStore(dir));
    expect((await (await restarted.latest()).json()).capture.cookies).toHaveLength(1);
  });
  it('refuses uploads while paused and changes from anywhere but the extension', async () => {
    const { connect, api } = setup();
    const { tokens } = await connect();
    await api(tokens!, '/api/v1/sync/adopt', {
      method: 'POST',
      body: JSON.stringify({ settings: { sites: ['github.com'], excludedDomains: [], paused: true } }),
    });
    const paused = await api(tokens!, '/api/v1/captures', {
      method: 'POST',
      body: JSON.stringify({ capture: capture([cookie()]) }),
    });
    expect(paused.status).toBe(409);
    expect(await paused.json()).toMatchObject({ error: 'sync_paused' });
    const page = await api(tokens!, '/api/v1/sync', {
      method: 'PATCH',
      body: JSON.stringify({ paused: false }),
      headers: { origin: config.PUBLIC_URL },
    });
    expect(page.status).toBe(403);
    expect((await api({ ...tokens!, access: 'forged' }, '/api/v1/me')).status).toBe(401);
  });
});

describe('tokens', () => {
  it('rotates refresh tokens, answers a retry the same way, and disconnects a browser whose old token is replayed', async () => {
    const { connect, api, fetcher, clock, latest } = setup();
    const { tokens } = await connect();
    await api(tokens!, '/api/v1/captures', { method: 'POST', body: JSON.stringify({ capture: capture([cookie()]) }) });
    const first = await requestTokens(fetcher, config.PUBLIC_URL, { refreshToken: tokens!.refresh });
    const retry = await requestTokens(fetcher, config.PUBLIC_URL, { refreshToken: tokens!.refresh });
    if (typeof first === 'string' || typeof retry === 'string') throw new Error('no tokens');
    expect(retry.tokens.refresh).toBe(first.tokens.refresh);
    expect((await api(first.tokens, '/api/v1/me')).status).toBe(200);
    clock.now += (refreshReuseSeconds + 1) * 1000;
    expect(await requestTokens(fetcher, config.PUBLIC_URL, { refreshToken: tokens!.refresh })).toBe('invalid_grant');
    expect((await api(first.tokens, '/api/v1/me')).status).toBe(401);
    expect((await latest()).status).toBe(404);
  });
  it('disconnects the browser and deletes what it uploaded', async () => {
    const { connect, api, latest } = setup();
    const { tokens } = await connect();
    await api(tokens!, '/api/v1/captures', { method: 'POST', body: JSON.stringify({ capture: capture([cookie()]) }) });
    expect(await (await api(tokens!, '/api/v1/captures', { method: 'DELETE' })).json()).toEqual({ deleted: true });
    expect((await latest()).status).toBe(404);
    expect((await api(tokens!, '/api/v1/me')).status).toBe(401);
  });
  it('expires access tokens after five minutes', async () => {
    const { connect, api, clock } = setup();
    const { tokens } = await connect();
    clock.now += 5 * 60_000 + 1;
    expect((await api(tokens!, '/api/v1/me')).status).toBe(401);
  });
});

describe('configuration', () => {
  it('requires HTTPS, an extension origin, and a 32-byte key', () => {
    const env = {
      PUBLIC_URL: 'https://sync.example.test/path',
      EXTENSION_ORIGINS: extension,
      ACCESS_KEY: config.ACCESS_KEY,
      API_KEY: config.API_KEY,
      CAPTURE_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    };
    expect(readConfig(env).PUBLIC_URL).toBe('https://sync.example.test');
    expect(() => readConfig({ ...env, PUBLIC_URL: 'http://sync.example.test' })).toThrow('HTTPS');
    expect(() => readConfig({ ...env, EXTENSION_ORIGINS: 'https://evil.test' })).toThrow('EXTENSION_ORIGINS');
    expect(() => readConfig({ ...env, CAPTURE_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow('CAPTURE_ENCRYPTION_KEY');
  });
});
