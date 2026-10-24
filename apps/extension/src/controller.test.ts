import { createHash } from 'node:crypto';
import { applySyncChange, browserOrigins, refreshRetryMs, type SyncSettings } from '@agent-computers/capture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountKey,
  type CaptureBrowser,
  CaptureController,
  type Distribution,
  recordKey,
  settingsKey,
  syncAlarm,
  syncKey,
  tokensKey,
  trustedSender,
} from './controller';

const origin = 'https://server.test';
const issuer = `${origin}/api/auth`;
const redirectUri = 'chrome-extension://own/connected.html';
const emails: { [user: string]: string } = { 'user-a': 'a@example.test', 'user-b': 'b@example.test' };
const answer = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });
const accepted = (status = 'stored') => answer(200, { status, completedAt: new Date().toISOString(), cookieCount: 2 });
const failure = (status: number, error = 'x') => answer(status, { error });
const siteGrants = (site: string) => [`https://*.${site}/*`, `http://*.${site}/*`];
// Every request to the server goes without cookies (no host grant, so credentialed CORS would fail).
let credentialed: string[] = [];
afterEach(() => {
  expect(credentialed).toEqual([]);
  credentialed = [];
  vi.restoreAllMocks();
});

const cookie = {
  name: 'synthetic',
  value: 'fixture-only-sensitive-marker',
  domain: 'capture.test',
  hostOnly: true,
  path: '/private',
  secure: true,
  httpOnly: true,
  sameSite: 'strict' as const,
  session: true,
  storeId: '0',
};
// How the server's token endpoint can fail: `network` before it is reached, `lost` after it rotated the token,
// `replay_pending` a retry that arrives before the server saved the answer to replay (invalid_grant).
type TokenFailure = 'network' | 'lost' | 'replay_pending' | '5xx' | '429';
function setup(initial?: unknown) {
  let session: { [key: string]: unknown } = initial ? { [recordKey]: initial } : {};
  let local: { [key: string]: unknown } = {};
  const grants = new Set<string>();
  const getAll = vi.fn(async () => [cookie, { ...cookie, domain: 'other.test' }]);
  const alarms = new Map<string, { periodInMinutes: number } | { when: number }>();
  // POST and DELETE /api/v1/captures, once the bearer token is accepted.
  const fetch = vi.fn(async (_url: string, init: RequestInit) =>
    init.method === 'DELETE' ? new Response(null, { status: 204 }) : accepted(),
  );
  // GET /api/v1/me for the token's owner.
  const me = vi.fn(async (user: string) => answer(200, { user: { id: user, email: emails[user], name: 'A' } }));
  // Each account's sync settings (/api/v1/sync): a small fake of the server's rules.
  type Account = { settings: SyncSettings | null; disconnected: boolean; config?: unknown };
  const accounts: { [user: string]: Account } = {
    'user-a': { settings: null, disconnected: false },
    'user-b': { settings: null, disconnected: false },
  };
  const account = accounts['user-a']!;
  const syncApi = vi.fn(async (url: string, init: RequestInit, user: string) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    const theirs = accounts[user]!;
    if (url.endsWith('/adopt')) {
      theirs.settings ??= applySyncChange(body.settings, {}, 'server.test');
      theirs.disconnected = false;
      return answer(200, { settings: theirs.settings });
    }
    if (init.method === 'PATCH') {
      if (!theirs.settings) return answer(409, { error: 'sync_settings_missing' });
      theirs.settings = applySyncChange(theirs.settings, body, 'server.test');
      return answer(200, { settings: theirs.settings });
    }
    return answer(200, {
      settings: theirs.settings,
      disconnected: theirs.disconnected,
      ...(theirs.config ? { config: theirs.config } : {}),
    });
  });
  // The server's OAuth rules the extension relies on, as packages/server/src/browsers.test.ts and the contract case in
  // packages/api/src/extension-oauth.test.ts prove them against real Better Auth: single-use codes bound to the PKCE
  // challenge and redirect URI; rotating refresh tokens whose rotated token gets the same answer for 30 seconds and
  // disconnects its family after; a disconnected family's tokens refused.
  let counter = 0;
  const codes = new Map<string, { user: string; challenge: string; redirectUri: string }>();
  const accessTokens = new Map<string, { user: string; family: string }>();
  const refreshTokens = new Map<string, { user: string; family: string; rotatedAt?: number; answer?: object }>();
  const revoked = new Set<string>();
  const failures: TokenFailure[] = [];
  // Set by refuseAccess: access tokens minted from then on are refused too.
  let refuseIssued = false;
  const issue = (user: string, family: string) => {
    counter++;
    const tokens = {
      access_token: `access-${counter}`,
      token_type: 'Bearer',
      expires_in: 300,
      refresh_token: `refresh-${counter}`,
      scope: 'offline_access sync',
    };
    if (!refuseIssued) accessTokens.set(tokens.access_token, { user, family });
    refreshTokens.set(tokens.refresh_token, { user, family });
    return tokens;
  };
  const invalidGrant = () => answer(400, { error: 'invalid_grant' });
  const grantTokens = (body: URLSearchParams) => {
    if (body.get('client_id') !== 'agent-computers-extension') return answer(401, { error: 'invalid_client' });
    if (body.get('grant_type') === 'authorization_code') {
      const code = codes.get(body.get('code') ?? '');
      codes.delete(body.get('code') ?? '');
      const challenge = createHash('sha256')
        .update(body.get('code_verifier') ?? '')
        .digest('base64url');
      if (!code || code.redirectUri !== body.get('redirect_uri') || code.challenge !== challenge) return invalidGrant();
      return answer(200, issue(code.user, `family-${counter + 1}`));
    }
    const presented = refreshTokens.get(body.get('refresh_token') ?? '');
    if (!presented || revoked.has(presented.family)) return invalidGrant();
    if (presented.answer) {
      if (Date.now() - presented.rotatedAt! <= 30_000) return answer(200, presented.answer);
      revoked.add(presented.family);
      return invalidGrant();
    }
    presented.answer = issue(presented.user, presented.family);
    presented.rotatedAt = Date.now();
    return answer(200, presented.answer);
  };
  const token = vi.fn(async (body: URLSearchParams) => {
    const failure = failures.shift();
    if (failure === 'network') throw new TypeError('network');
    if (failure === '5xx') return answer(503, { error: 'server_error' });
    if (failure === '429') return answer(429, { error: 'rate_limited' });
    if (failure === 'replay_pending') return invalidGrant();
    const response = grantTokens(body);
    if (failure === 'lost') throw new TypeError('network');
    return response;
  });
  const bearer = (init: RequestInit) => {
    const presented = /^Bearer (.+)$/.exec(
      (init.headers as { [name: string]: string } | undefined)?.authorization ?? '',
    );
    const found = presented ? accessTokens.get(presented[1]!) : undefined;
    return found && !revoked.has(found.family) ? found : undefined;
  };
  const requests: { url: string; init: RequestInit }[] = [];
  const route = async (url: string, init: RequestInit = {}) => {
    requests.push({ url, init });
    if (init.credentials !== 'omit') credentialed.push(url);
    if (url === `${issuer}/oauth2/token`) return token(new URLSearchParams(String(init.body)));
    const caller = bearer(init);
    if (!caller) return failure(401, 'unauthenticated');
    if (url === `${origin}/api/v1/me`) return me(caller.user);
    if (url.startsWith(`${origin}/api/v1/sync`)) return syncApi(url, init, caller.user);
    const response = await fetch(url, init);
    // DELETE /captures disconnects the browser that sent it.
    if (url === `${origin}/api/v1/captures` && init.method === 'DELETE' && response.ok) revoked.add(caller.family);
    return response;
  };
  const remove = (area: () => { [key: string]: unknown }, assign: (next: { [key: string]: unknown }) => void) =>
    vi.fn(async (keys: string | string[]) => {
      const next = { ...area() };
      for (const key of [keys].flat()) delete next[key];
      assign(next);
    });
  let badge = '';
  let tabId = 100;
  const api = {
    permissions: {
      contains: vi.fn(async ({ origins }: { origins: string[] }) => origins.every(origin => grants.has(origin))),
      getAll: vi.fn(async () => ({ origins: [...grants] })),
      remove: vi.fn(async ({ origins }: { origins: string[] }) => {
        for (const origin of origins) grants.delete(origin);
        return true;
      }),
    },
    cookies: { getAll },
    storage: {
      session: {
        get: vi.fn(async () => structuredClone(session)),
        set: vi.fn(async (data: object) => {
          session = { ...session, ...structuredClone(data) };
        }),
        remove: remove(
          () => session,
          next => {
            session = next;
          },
        ),
        setAccessLevel: vi.fn(async () => undefined),
      },
      local: {
        get: vi.fn(async () => structuredClone(local)),
        set: vi.fn(async (data: object) => {
          local = { ...local, ...structuredClone(data) };
        }),
        remove: remove(
          () => local,
          next => {
            local = next;
          },
        ),
        setAccessLevel: vi.fn(async () => undefined),
      },
    },
    alarms: {
      get: vi.fn(async (name: string) => alarms.get(name)),
      create: vi.fn(async (name: string, info: { periodInMinutes: number } | { when: number }) => {
        alarms.set(name, info);
      }),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
    },
    tabs: {
      create: vi.fn(async (properties: { url: string }) => ({ id: tabId++, ...properties })),
      query: vi.fn(async () => [{ id: 7 }]),
      get: vi.fn(async (id: number) => ({ id, windowId: 1, index: 0 })),
    },
    action: {
      setBadgeText: vi.fn(async ({ text }: { text: string }) => {
        badge = text;
      }),
    },
    runtime: {
      requestUpdateCheck: vi.fn(async () => ({
        status: 'no_update' as chrome.runtime.RequestUpdateCheckResult['status'],
      })),
      reload: vi.fn(),
    },
    fetch: route,
  };
  const restart = (distribution: Distribution = 'manual', version = '0.5.0') =>
    new CaptureController(api as unknown as CaptureBrowser, origin, version, distribution, redirectUri);
  const controller = restart();
  const grant = () => {
    for (const origin of browserOrigins) grants.add(origin);
  };
  // The authorize URL the last connect opened, which must ask for the sync scope with PKCE and nothing more.
  const authorizeRequest = () => {
    const url = new URL(api.tabs.create.mock.calls.at(-1)![0].url);
    expect(`${url.origin}${url.pathname}`).toBe(`${issuer}/oauth2/authorize`);
    const params = Object.fromEntries(url.searchParams);
    expect(params).toEqual({
      response_type: 'code',
      client_id: 'agent-computers-extension',
      redirect_uri: redirectUri,
      scope: 'offline_access sync',
      code_challenge: expect.stringMatching(/^[\w-]{43}$/),
      code_challenge_method: 'S256',
      state: expect.stringMatching(/^[\w-]{43}$/),
    });
    return { state: params.state!, challenge: params.code_challenge! };
  };
  // The server signs the user in and redirects with a code for them.
  const mint = (user = 'user-a') => {
    const { state, challenge } = authorizeRequest();
    const code = `code-${++counter}`;
    codes.set(code, { user, challenge, redirectUri });
    return { code, state };
  };
  const exchange = (url: string) => controller.handle({ type: 'exchange', url });
  const redirect = (params: { [name: string]: string }) => `${redirectUri}?${new URLSearchParams(params)}`;
  const authorize = (user = 'user-a') => exchange(redirect({ ...mint(user), iss: issuer }));
  // Waits for the work the exchange queued: the account's settings and the first sync.
  const drain = () => controller.handle({ type: 'status' });
  // Connecting with all sites captures right away. Here that first upload fails, so each test starts connected with
  // nothing uploaded yet, and the next capture is still the first upload after connecting.
  const connect = async () => {
    grant();
    fetch.mockRejectedValueOnce(new TypeError('network'));
    await controller.handle({ type: 'connect', mode: 'all' });
    await authorize();
    await drain();
    fetch.mockClear();
    getAll.mockClear();
    token.mockClear();
  };
  const uploads = () => fetch.mock.calls.filter(([, init]) => init.method === 'POST');
  // A change on the account page, which this browser takes when the popup next opens.
  const fromAccount = async (change: Parameters<typeof applySyncChange>[1]) => {
    account.settings = applySyncChange(account.settings!, change, 'server.test');
    return controller.handle({ type: 'check' });
  };
  return {
    controller,
    restart,
    api,
    grants,
    getAll,
    alarms,
    fetch,
    me,
    token,
    account,
    accounts,
    syncApi,
    requests,
    fromAccount,
    uploads,
    session: () => session,
    local: () => local,
    badge: () => badge,
    grant,
    connect,
    mint,
    exchange,
    redirect,
    authorize,
    drain,
    // The server disconnects every browser (Turn off sync, the account page's Disconnect).
    revokeFamily: () => {
      for (const { family } of [...accessTokens.values(), ...refreshTokens.values()]) revoked.add(family);
    },
    // The server refuses the current access tokens, as signing out on the server's website does.
    expireAccess: () => accessTokens.clear(),
    // The server refuses every access token, including the ones a refresh mints.
    refuseAccess: () => {
      accessTokens.clear();
      refuseIssued = true;
    },
    failNextToken: (...kinds: TokenFailure[]) => failures.push(...kinds),
  };
}
type Test = ReturnType<typeof setup>;
// Lets a capture the timers started finish; setImmediate is left real.
const settle = () => new Promise(resolve => setImmediate(resolve));
const withFakeTimers = (run: () => Promise<void>) => async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
};

describe('added sites', () => {
  async function connected() {
    const test = setup();
    test.getAll.mockImplementation(async () => [
      cookie,
      { ...cookie, domain: '.sub.capture.test', hostOnly: false },
      { ...cookie, domain: 'other.test' },
      { ...cookie, domain: 'server.test' },
    ]);
    await test.controller.handle({ type: 'connect', mode: 'sites' });
    await test.authorize();
    expect(await test.drain()).toMatchObject({
      settings: { connected: true, mode: 'sites', sites: [] },
      account: { state: 'syncing', email: 'a@example.test' },
    });
    return test;
  }
  const add = async (test: Test, sites: string[]) => {
    for (const site of sites) for (const grant of siteGrants(site)) test.grants.add(grant);
    return test.controller.handle({ type: 'sites', sites });
  };
  it('connects with no grant in a tab beside the current one, and captures only granted, added sites', async () => {
    const test = setup();
    expect(await test.controller.handle({ type: 'connect', mode: 'sites' })).toMatchObject({
      connecting: true,
      settings: { connected: false },
      account: { state: 'none' },
    });
    expect(test.api.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, windowId: 1, openerTabId: 7, index: 1 }),
    );
    const ready = await connected();
    expect(await ready.controller.handle({ type: 'sites', sites: ['capture.test'] })).toEqual({
      ok: false,
      error: 'permission_required',
    });
    // Adding a subdomain adds its site, and the capture and upload run right away.
    for (const grant of siteGrants('capture.test')) ready.grants.add(grant);
    expect(await ready.controller.handle({ type: 'sites', sites: ['sub.capture.test'] })).toMatchObject({
      settings: { sites: ['capture.test'] },
      capture: { state: 'complete', cookieCount: 2 },
    });
    const init = ready.uploads()[0]![1];
    const { capture } = JSON.parse(String(init.body));
    expect(capture.scope).toEqual({ mode: 'sites', sites: ['capture.test'], excludedDomains: [] });
    expect(capture.cookies.map((each: { domain: string }) => each.domain)).toEqual([
      'capture.test',
      '.sub.capture.test',
    ]);
  });
  it('removing a site removes it from the account and revokes its grant before uploading the rest', async () => {
    const test = await connected();
    await add(test, ['capture.test', 'other.test']);
    expect(test.account.settings).toMatchObject({ sites: ['capture.test', 'other.test'] });
    test.fetch.mockClear();
    expect(await test.controller.handle({ type: 'sites', sites: ['capture.test'] })).toMatchObject({
      settings: { sites: ['capture.test'] },
      capture: { cookieCount: 2 },
    });
    expect(test.account.settings).toMatchObject({ sites: ['capture.test'] });
    expect(test.api.permissions.remove).toHaveBeenCalledWith({ origins: siteGrants('other.test') });
    expect(test.grants.has(siteGrants('other.test')[0]!)).toBe(false);
    // The server deletes the removed site's uploaded copy itself.
    expect(test.fetch.mock.calls.map(([, init]) => init.method)).toEqual(['POST']);
    // Unreachable, nothing changes here either.
    test.syncApi.mockRejectedValueOnce(new TypeError('network'));
    expect(await test.controller.handle({ type: 'sites', sites: [] })).toEqual({ ok: false, error: 'unavailable' });
    expect(await test.controller.handle({ type: 'status' })).toMatchObject({ settings: { sites: ['capture.test'] } });
    expect(test.grants.has(siteGrants('capture.test')[0]!)).toBe(true);
    test.syncApi.mockRejectedValueOnce(new TypeError('network'));
    expect(await add(test, ['capture.test', 'other.test'])).toEqual({ ok: false, error: 'unavailable' });
    expect(test.grants.has(siteGrants('other.test')[0]!)).toBe(false);
  });
  it("refuses excluded sites and the Agent Computers site, and the account's exclusion removes an added site", async () => {
    const test = await connected();
    await test.fromAccount({ excludedDomains: ['other.test'] });
    expect(await add(test, ['other.test'])).toEqual({ ok: false, error: 'excluded' });
    expect(await add(test, ['server.test'])).toEqual({ ok: false, error: 'excluded' });
    await add(test, ['capture.test']);
    expect(await test.fromAccount({ excludedDomains: ['capture.test'] })).toMatchObject({
      settings: { sites: [], excludedDomains: ['capture.test'] },
    });
    expect(test.grants.has(siteGrants('capture.test')[0]!)).toBe(false);
    // Removing an exclusion on the account page lets the site be added again.
    await test.fromAccount({ excludedDomains: [] });
    expect(await add(test, ['capture.test'])).toMatchObject({ settings: { sites: ['capture.test'] } });
  });
  it('takes sites the account page removed, and lists sites this browser has not granted without capturing them', async () => {
    const test = await connected();
    await add(test, ['capture.test', 'other.test']);
    expect(await test.fromAccount({ removeSites: ['other.test'] })).toMatchObject({
      settings: { sites: ['capture.test'] },
      ungrantedSites: [],
    });
    expect(test.grants.has(siteGrants('other.test')[0]!)).toBe(false);
    // Another browser added a site this one has not granted.
    expect(await test.fromAccount({ addSites: ['other.test'] })).toMatchObject({
      settings: { sites: ['capture.test', 'other.test'] },
      ungrantedSites: ['other.test'],
    });
    test.fetch.mockClear();
    await test.controller.handle({ type: 'capture' });
    const { capture } = JSON.parse(String(test.uploads()[0]![1].body));
    expect(capture.scope.sites).toEqual(['capture.test']);
    expect(capture.cookies.map((each: { domain: string }) => each.domain)).not.toContain('other.test');
    // Granting it here captures it, without changing the account's sites.
    expect(await add(test, ['capture.test', 'other.test'])).toMatchObject({
      ungrantedSites: [],
      capture: { cookieCount: 3 },
    });
  });
  it('drops a site revoked in Chrome without disconnecting, even the last one', async () => {
    const test = await connected();
    await add(test, ['capture.test', 'other.test']);
    for (const grant of siteGrants('other.test')) test.grants.delete(grant);
    test.fetch.mockClear();
    await test.controller.permissionsRemoved(siteGrants('other.test'));
    expect(await test.controller.handle({ type: 'status' })).toMatchObject({
      settings: { connected: true, sites: ['capture.test'] },
    });
    // The account drops it too, and the server deletes its uploaded copy.
    expect(test.account.settings).toMatchObject({ sites: ['capture.test'] });
    expect(test.fetch).not.toHaveBeenCalled();
    // Unreachable, the account is told at the next fetch.
    await add(test, ['capture.test', 'other.test']);
    for (const grant of siteGrants('other.test')) test.grants.delete(grant);
    test.syncApi.mockRejectedValueOnce(new TypeError('network'));
    await test.controller.permissionsRemoved(siteGrants('other.test'));
    expect(test.account.settings).toMatchObject({ sites: ['capture.test', 'other.test'] });
    expect(await test.controller.handle({ type: 'check' })).toMatchObject({
      settings: { sites: ['capture.test'] },
      ungrantedSites: [],
    });
    expect(test.account.settings).toMatchObject({ sites: ['capture.test'] });
    // Added sites need no other grant, so losing every one keeps the connection.
    test.grants.clear();
    await test.controller.permissionsRemoved(siteGrants('capture.test'));
    expect(await test.controller.handle({ type: 'status' })).toMatchObject({
      settings: { connected: true, sites: [] },
      account: { state: 'syncing' },
    });
  });
  it('uploads when a site with no cookies is added, since the added sites changed', async () => {
    const test = await connected();
    await add(test, ['capture.test']);
    test.fetch.mockClear();
    expect(await add(test, ['capture.test', 'empty.test'])).toMatchObject({
      capture: { cookieCount: 2 },
      sync: { state: 'synced' },
    });
    const [[, init]] = test.uploads() as [[string, RequestInit]];
    expect(JSON.parse(String(init.body)).capture.scope.sites).toEqual(['capture.test', 'empty.test']);
    // The same cookies and sites again skip the upload.
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ sync: { state: 'unchanged' } });
    expect(test.uploads()).toHaveLength(1);
  });
  it('switches to all sites without a new tab, and back with Use added sites only, keeping the connection', async () => {
    const test = await connected();
    await add(test, ['capture.test', 'other.test']);
    test.grant();
    expect(await test.controller.handle({ type: 'connect', mode: 'all' })).toMatchObject({
      settings: { mode: 'all', sites: ['capture.test', 'other.test'] },
      capture: { cookieCount: 3 },
      account: { state: 'syncing' },
    });
    expect(test.api.tabs.create).toHaveBeenCalledTimes(1);
    // Removing the all-sites grant takes every site grant with it in Chrome.
    test.api.permissions.remove.mockImplementationOnce(async ({ origins }) => {
      expect(origins).toEqual([...browserOrigins]);
      test.grants.clear();
      return true;
    });
    expect(await test.controller.handle({ type: 'narrow' })).toMatchObject({
      settings: { connected: true, mode: 'sites', sites: ['capture.test', 'other.test'] },
      ungrantedSites: ['capture.test', 'other.test'],
      account: { state: 'syncing' },
    });
    // Chrome's event lists every removed pattern; the sites it took along are not revoked from the account.
    await test.controller.permissionsRemoved([
      ...browserOrigins,
      ...siteGrants('capture.test'),
      ...siteGrants('other.test'),
    ]);
    expect(test.account.settings).toMatchObject({ sites: ['capture.test', 'other.test'] });
    // The popup asks for them again in the click; one comes back.
    for (const grant of siteGrants('capture.test')) test.grants.add(grant);
    test.fetch.mockClear();
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({
      settings: { sites: ['capture.test', 'other.test'] },
      ungrantedSites: ['other.test'],
      capture: { cookieCount: 2 },
    });
    expect(JSON.parse(String(test.uploads()[0]![1].body)).capture.scope.sites).toEqual(['capture.test']);
    expect(await test.controller.handle({ type: 'narrow' })).toEqual({ ok: false, error: 'invalid_request' });
    // A site's own grant removed later is still a revocation.
    for (const grant of siteGrants('capture.test')) test.grants.delete(grant);
    await test.controller.permissionsRemoved(siteGrants('capture.test'));
    expect(test.account.settings).toMatchObject({ sites: ['other.test'] });
    expect(await test.controller.handle({ type: 'disconnect' })).toMatchObject({
      settings: { connected: false, mode: 'sites', sites: ['other.test'] },
    });
    expect(await test.controller.handle({ type: 'reconnect' })).toEqual({ ok: false, error: 'invalid_request' });
    for (const grant of siteGrants('capture.test')) test.grants.add(grant);
    // Connecting again after Disconnect opens a tab, and the account keeps its sites.
    await test.controller.handle({ type: 'connect', mode: 'sites' });
    await test.authorize();
    expect(await test.drain()).toMatchObject({
      settings: { connected: true, mode: 'sites', sites: ['other.test'] },
      ungrantedSites: ['other.test'],
    });
  });
  it('refuses all sites in a store build, even when Chrome grants it, and connects with added sites', async () => {
    const test = setup();
    const store = test.restart('store');
    test.grant();
    const refused = { ok: false, error: 'invalid_request' };
    expect(await store.handle({ type: 'connect', mode: 'all' })).toEqual(refused);
    expect(await store.handle({ type: 'prepare', connect: 'all', sites: [] })).toEqual(refused);
    expect(await store.handle({ type: 'status' })).toMatchObject({ settings: { connected: false } });
    expect(test.api.tabs.create).not.toHaveBeenCalled();
    expect(await store.handle({ type: 'connect', mode: 'sites' })).toMatchObject({ connecting: true });
  });
  const change = (test: Test, changed: typeof cookie, removed = false, cause = 'explicit') =>
    test.controller.cookieChanged({ cookie: changed, removed, cause });
  it(
    'syncs a sign-in or sign-out within seconds, and leaves rotated values to the periodic capture',
    withFakeTimers(async () => {
      const test = await connected();
      await add(test, ['capture.test']);
      test.getAll.mockClear();
      test.fetch.mockClear();
      // Other sites, the sync server, a rotated value, an overwrite, and expiry start nothing.
      await change(test, { ...cookie, name: 'new', domain: 'other.test' });
      await change(test, { ...cookie, name: 'new', domain: 'server.test' });
      await change(test, { ...cookie, value: 'rotated' });
      await change(test, cookie, true, 'overwrite');
      await change(test, cookie, true, 'expired');
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(test.getAll).not.toHaveBeenCalled();
      // A sign-in's cookies settle for 2 seconds, but the capture waits no more than 4 after the first.
      const session = { ...cookie, name: 'session' };
      test.getAll.mockImplementation(async () => [cookie, session]);
      await change(test, session);
      await vi.advanceTimersByTimeAsync(1_500);
      await change(test, { ...session, name: 'csrf' });
      await vi.advanceTimersByTimeAsync(1_500);
      await change(test, { ...session, name: 'more' });
      await vi.advanceTimersByTimeAsync(999);
      await settle();
      expect(test.getAll).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(test.uploads()).toHaveLength(1));
      // Signing out deletes a captured cookie, and quick captures run at most every 10 seconds.
      test.getAll.mockImplementation(async () => [cookie]);
      await change(test, session, true, 'expired_overwrite');
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      expect(test.getAll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(test.uploads()).toHaveLength(2));
    }),
  );
  it(
    'quick-captures with all sites too, but not while paused or for excluded domains',
    withFakeTimers(async () => {
      const test = await connected();
      await add(test, ['capture.test', 'other.test']);
      await test.fromAccount({ excludedDomains: ['sub.capture.test'] });
      test.getAll.mockClear();
      const fresh = { ...cookie, name: 'fresh' };
      await change(test, { ...fresh, domain: 'sub.capture.test' });
      await test.controller.handle({ type: 'pause' });
      await change(test, fresh);
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(test.getAll).not.toHaveBeenCalled();
      await test.controller.handle({ type: 'resume' });
      test.grant();
      await test.controller.handle({ type: 'connect', mode: 'all' });
      test.getAll.mockClear();
      await change(test, { ...fresh, domain: 'elsewhere.test' });
      await vi.advanceTimersByTimeAsync(4_000);
      await vi.waitFor(() => expect(test.getAll).toHaveBeenCalledTimes(1));
    }),
  );
  it('reports captures over the upload limit as too large, from this check or the server', async () => {
    const test = await connected();
    test.getAll.mockImplementation(async () =>
      Array.from({ length: 300 }, (_, index) => ({ ...cookie, name: `big${index}`, value: 'v'.repeat(16_000) })),
    );
    test.fetch.mockClear();
    expect(await add(test, ['capture.test'])).toMatchObject({ sync: { state: 'too_large' } });
    expect(test.uploads()).toHaveLength(0);
    test.getAll.mockImplementation(async () => [cookie]);
    test.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'capture_too_large' }), { status: 413 }));
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ sync: { state: 'too_large' } });
  });
  it('finishes a prepared click when the grant arrives, after the prompt closed the popup', async () => {
    const test = await connected();
    await test.controller.handle({ type: 'prepare', sites: ['capture.test'] });
    // Before the grant nothing happens, and the click stays pending.
    expect(await test.controller.handle({ type: 'finish' })).toMatchObject({ settings: { sites: [] } });
    for (const grant of siteGrants('capture.test')) test.grants.add(grant);
    test.fetch.mockClear();
    expect(await test.controller.permissionsAdded()).toMatchObject({
      settings: { sites: ['capture.test'] },
      capture: { state: 'complete' },
    });
    expect(test.uploads()).toHaveLength(1);
    // The popup's own finish, if it survived, finds nothing left to do.
    expect(await test.controller.handle({ type: 'finish' })).toMatchObject({ settings: { sites: ['capture.test'] } });
    expect(test.uploads()).toHaveLength(1);
  });
  it('connects and adds the first site from one grant, and lets an unanswered click expire', async () => {
    const test = setup();
    // The setup tab's click: its tab is where the connect tab returns.
    await test.controller.handle({ type: 'prepare', connect: 'sites', sites: ['capture.test'] }, { tab: 3 });
    for (const grant of siteGrants('capture.test')) test.grants.add(grant);
    expect(await test.controller.permissionsAdded()).toMatchObject({
      connecting: true,
      settings: { connected: false },
    });
    expect(test.api.tabs.get).toHaveBeenCalledWith(3);
    expect(await test.authorize()).toEqual({ ok: true, email: 'a@example.test', opener: 3 });
    expect(await test.drain()).toMatchObject({
      settings: { connected: true, mode: 'sites', sites: ['capture.test'] },
      capture: { state: 'complete' },
    });
    expect(test.account.settings).toMatchObject({ sites: ['capture.test'] });
    await test.controller.handle({ type: 'prepare', sites: ['other.test'] });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 121_000);
    for (const grant of siteGrants('other.test')) test.grants.add(grant);
    expect(await test.controller.permissionsAdded()).toMatchObject({ settings: { sites: ['capture.test'] } });
  });
  it('keeps a whole-browser connection from before site selection as all sites', async () => {
    const test = setup();
    test.grant();
    await test.api.storage.local.set({
      [settingsKey]: { consentVersion: 1, connected: true, paused: false, excludedDomains: ['other.test'] },
    });
    expect(await test.restart().handle({ type: 'status' })).toMatchObject({
      settings: { connected: true, mode: 'all', sites: [], excludedDomains: ['other.test'] },
    });
  });
});

describe('whole-browser authorization and lifecycle', () => {
  it('does not read cookies without broad permission and explicit connection', async () => {
    const test = setup();
    expect(await test.controller.handle({ type: 'capture' })).toEqual({ ok: false, error: 'permission_required' });
    test.grant();
    expect(await test.controller.handle({ type: 'capture' })).toEqual({ ok: false, error: 'permission_required' });
    expect(test.getAll).not.toHaveBeenCalled();
  });
  it('captures arbitrary domains after one connection, without cookie values in responses/local storage', async () => {
    const test = setup();
    await test.connect();
    const result = await test.controller.handle({ type: 'capture' });
    expect(result).toMatchObject({ ok: true, capture: { state: 'complete', cookieCount: 2 } });
    expect(JSON.stringify(result)).not.toContain(cookie.value);
    expect(JSON.stringify(test.local())).not.toContain(cookie.value);
    expect(test.getAll).toHaveBeenCalledWith({ partitionKey: {} });
    expect(test.session()[recordKey]).toMatchObject({
      bundle: { schemaVersion: 2, scope: { mode: 'whole-browser', excludedDomains: [] } },
    });
  });
  it('captures and uploads right away once connected with all sites', async () => {
    const test = setup();
    test.grant();
    expect(await test.controller.handle({ type: 'connect', mode: 'all' })).toMatchObject({ connecting: true });
    expect(test.getAll).not.toHaveBeenCalled();
    await test.authorize();
    expect(await test.drain()).toMatchObject({
      settings: { connected: true, mode: 'all' },
      capture: { state: 'complete', cookieCount: 2 },
      sync: { state: 'synced' },
    });
    expect(JSON.parse(String(test.uploads()[0]![1].body))).toMatchObject({
      connect: true,
      capture: { scope: { mode: 'whole-browser' } },
    });
    expect(test.alarms.get(syncAlarm)).toEqual({ periodInMinutes: 1 });
  });
  it('discards the first capture of an all-sites connection that Pause interrupted', async () => {
    const test = setup();
    test.grant();
    let release!: (cookies: (typeof cookie)[]) => void;
    test.getAll.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    await test.controller.handle({ type: 'connect', mode: 'all' });
    await test.authorize();
    await vi.waitFor(() => expect(test.getAll).toHaveBeenCalled());
    const pausing = test.controller.handle({ type: 'pause' });
    release([cookie]);
    expect(await pausing).toMatchObject({ settings: { connected: true, paused: true } });
    expect(test.uploads()).toHaveLength(0);
    expect(JSON.stringify(test.session())).not.toContain(cookie.value);
  });
  it('finishes a prepared all-sites click with the capture', async () => {
    const test = setup();
    await test.controller.handle({ type: 'prepare', connect: 'all', sites: [] });
    test.grant();
    expect(await test.controller.permissionsAdded()).toMatchObject({ connecting: true });
    await test.authorize();
    expect(await test.drain()).toMatchObject({
      settings: { connected: true, mode: 'all' },
      capture: { state: 'complete' },
    });
    expect(test.uploads()).toHaveLength(1);
  });
  it('requires both schemes and refuses partial grants', async () => {
    const test = setup();
    test.grants.add(browserOrigins[1]);
    expect(await test.controller.handle({ type: 'connect', mode: 'all' })).toEqual({
      ok: false,
      error: 'permission_required',
    });
    expect(test.getAll).not.toHaveBeenCalled();
    expect(test.api.tabs.create).not.toHaveBeenCalled();
  });
  it('clears old captures on exclusions changes and filters new captures before saving', async () => {
    const test = setup();
    await test.connect();
    await test.controller.handle({ type: 'capture' });
    await test.fromAccount({ excludedDomains: ['capture.test'] });
    expect(JSON.stringify(test.session())).not.toContain(cookie.value);
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ capture: { cookieCount: 1 } });
    expect(test.session()[recordKey]).toMatchObject({ bundle: { cookies: [{ ...cookie, domain: 'other.test' }] } });
  });
  it('pauses across worker restarts and clears retained data, then resumes explicitly', async () => {
    const test = setup();
    await test.connect();
    await test.controller.handle({ type: 'capture' });
    await test.controller.handle({ type: 'pause' });
    expect(JSON.stringify(test.session())).not.toContain(cookie.value);
    const next = test.restart();
    expect(await next.handle({ type: 'capture' })).toEqual({ ok: false, error: 'paused' });
    expect(await next.handle({ type: 'status' })).toMatchObject({ settings: { connected: true, paused: true } });
    await next.handle({ type: 'resume' });
    expect(await next.handle({ type: 'capture' })).toMatchObject({ capture: { state: 'complete' } });
  });
  it.each(['disconnect', 'pause', 'clear', 'external revoke'])(
    '%s during collection discards the in-flight result',
    async action => {
      const test = setup();
      await test.connect();
      let release!: (cookies: (typeof cookie)[]) => void;
      test.getAll.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            release = resolve;
          }),
      );
      const capturing = test.controller.handle({ type: 'capture' });
      await vi.waitFor(() => expect(test.getAll).toHaveBeenCalled());
      if (action === 'external revoke') test.grants.clear();
      const stopping =
        action === 'external revoke' ? test.controller.permissionsRemoved() : test.controller.handle({ type: action });
      release([cookie]);
      expect(await capturing).toMatchObject({ ok: false });
      await stopping;
      expect(JSON.stringify(test.session())).not.toContain(cookie.value);
    },
  );
  it('revocation during the final write prevents completion', async () => {
    const test = setup();
    await test.connect();
    const save = test.api.storage.session.set.getMockImplementation()!;
    test.api.storage.session.set.mockImplementation(async record => {
      await save(record);
      if (JSON.stringify(record).includes('"complete"')) test.grants.clear();
    });
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ ok: false });
    expect(JSON.stringify(test.session())).not.toContain(cookie.value);
  });
  it('disconnect removes all granted origins including old fixture grants, while retaining exclusions', async () => {
    const test = setup();
    await test.connect();
    test.grants.add('https://*.capture.test/*');
    test.grants.add(`${origin}/*`);
    await test.fromAccount({ excludedDomains: ['other.test'] });
    await test.controller.handle({ type: 'capture' });
    expect(await test.controller.handle({ type: 'disconnect' })).toMatchObject({
      settings: { connected: false, excludedDomains: ['other.test'] },
      permissionGranted: false,
    });
    expect(test.grants.size).toBe(0);
    expect(JSON.stringify(test.session())).not.toContain(cookie.value);
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ ok: false });
  });
  it('remains disconnected if Chrome permission removal fails', async () => {
    const test = setup();
    await test.connect();
    test.api.permissions.remove.mockRejectedValueOnce(new Error('removal failed'));
    expect(await test.controller.handle({ type: 'disconnect' })).toMatchObject({ ok: false });
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ ok: false });
    expect(test.local()[settingsKey]).toMatchObject({ connected: false });
    expect(test.local()[tokensKey]).toBeUndefined();
    expect(await test.controller.handle({ type: 'status' })).toMatchObject({
      permissionGranted: true,
      settings: { connected: false },
    });
  });
  it('sanitizes schema/API errors and does not publish success on storage exhaustion', async () => {
    const test = setup();
    await test.connect();
    test.getAll.mockRejectedValueOnce(new Error(cookie.value));
    expect(await test.controller.handle({ type: 'capture' })).toEqual({ ok: false, error: 'capture_failed' });
    test.getAll.mockResolvedValueOnce([{ ...cookie, storeId: '1' }, cookie]);
    expect(await test.controller.handle({ type: 'capture' })).toEqual({ ok: false, error: 'capture_failed' });
    const save = test.api.storage.session.set.getMockImplementation()!;
    test.api.storage.session.set.mockImplementation(async record => {
      if (JSON.stringify(record).includes('"bundle"')) throw new Error('quota');
      await save(record);
    });
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ ok: false });
    expect(test.session()[recordKey]).toMatchObject({ status: { state: 'failed' } });
  });
  it('reconciles a capture interrupted by a worker restart instead of reporting it complete', async () => {
    const test = setup();
    await test.connect();
    await test.api.storage.session.set({ [recordKey]: { status: { state: 'capturing' } } });
    expect(await test.restart().handle({ type: 'status' })).toMatchObject({ capture: { state: 'interrupted' } });
  });
  it('accepts the popup and the setup tab, the redirect page for the exchange only, and rejects others', () => {
    const page = (path: string, extra: object = {}) => ({ id: 'own', url: `chrome-extension://own/${path}`, ...extra });
    const tab = { tab: { id: 4 } as chrome.tabs.Tab, frameId: 0 };
    const status = { type: 'status' };
    const exchange = { type: 'exchange', url: `${redirectUri}?code=x` };
    expect(trustedSender(page('popup.html'), 'own', status)).toBe(true);
    expect(trustedSender(page('setup.html', tab), 'own', status)).toBe(true);
    expect(trustedSender(page('connected.html', tab), 'own', exchange)).toBe(true);
    expect(trustedSender(page('connected.html?code=x&state=y', tab), 'own', exchange)).toBe(true);
    for (const [sender, message] of [
      [{ id: 'own', url: 'https://capture.test/' }, status],
      [page('setup.html?x'), status],
      [page('other.html'), status],
      [{ ...page('popup.html'), id: 'other' }, status],
      [{ ...page('setup.html'), id: 'other' }, status],
      [{ id: 'own' }, status],
      [page('popup.html'), exchange],
      [page('setup.html', tab), exchange],
      [page('connected.html', tab), status],
      [page('connected.html', { ...tab, frameId: 1 }), exchange],
      [page('connected.html', { frameId: 0 }), exchange],
      [{ ...page('connected.html', tab), id: 'other' }, exchange],
    ] as const) {
      expect(trustedSender(sender, 'own', message), JSON.stringify([sender, message])).toBe(false);
    }
  });
});

describe('sync to the agent computer', () => {
  it('uploads a changed capture with the bearer token and no cookies, and records only metadata', async () => {
    const test = setup();
    await test.connect();
    const result = await test.controller.handle({ type: 'capture' });
    expect(result).toMatchObject({
      ok: true,
      capture: { state: 'complete' },
      sync: { state: 'synced', cookieCount: 2 },
    });
    expect(test.uploads()).toHaveLength(1);
    const [url, init] = test.uploads()[0]!;
    expect(url).toBe(`${origin}/api/v1/captures`);
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      headers: {
        'content-type': 'application/json',
        'x-extension-version': '0.5.0',
        authorization: `Bearer ${(test.local()[tokensKey] as { access: string }).access}`,
      },
    });
    expect(JSON.parse(init.body as string).capture.cookies).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('digest');
    expect(test.local()[syncKey]).toMatchObject({ state: 'synced', digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(test.local())).not.toContain(cookie.value);
  });
  it('reports a newer build the server offers, and an outdated refusal, until this build catches up', async () => {
    const test = setup();
    await test.connect();
    const offering = (latestVersion: string) =>
      new Response(
        JSON.stringify({ status: 'stored', completedAt: new Date().toISOString(), cookieCount: 2, latestVersion }),
        { status: 200 },
      );
    test.fetch.mockResolvedValueOnce(offering('0.5.0'));
    expect(await test.controller.handle({ type: 'capture' })).not.toHaveProperty('update');
    test.getAll.mockResolvedValueOnce([cookie]);
    test.fetch.mockResolvedValueOnce(offering('0.10.0'));
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ update: '0.10.0' });
    test.getAll.mockResolvedValueOnce([{ ...cookie, value: 'changed' }]);
    test.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'extension_outdated', latestVersion: '0.11.0' }), { status: 426 }),
    );
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({
      sync: { state: 'outdated' },
      update: '0.11.0',
    });
    // The periodic capture waits for the update; Sync now still tries.
    test.getAll.mockClear();
    expect(await test.controller.alarmFired(syncAlarm)).toBeUndefined();
    expect(test.getAll).not.toHaveBeenCalled();
    // The new build no longer sees an update, and syncs on its own again.
    expect(await test.restart().handle({ type: 'status' })).toMatchObject({ update: '0.11.0' });
    const updated = test.restart('manual', '0.11.0');
    expect(await updated.handle({ type: 'status' })).not.toHaveProperty('update');
    expect(await updated.alarmFired(syncAlarm)).toMatchObject({ sync: { state: 'synced' } });
  });
  it('never offers a store build the manual build, and updates it through Chrome', async () => {
    const test = setup();
    await test.connect();
    const store = test.restart('store');
    test.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'stored',
          completedAt: new Date().toISOString(),
          cookieCount: 2,
          latestVersion: '0.10.0',
        }),
        { status: 200 },
      ),
    );
    expect(await store.handle({ type: 'capture' })).not.toHaveProperty('update');
    test.getAll.mockResolvedValueOnce([{ ...cookie, value: 'changed' }]);
    test.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'extension_outdated', latestVersion: '0.11.0' }), { status: 426 }),
    );
    const outdated = await store.handle({ type: 'capture' });
    expect(outdated).toMatchObject({ sync: { state: 'outdated' } });
    expect(outdated).not.toHaveProperty('update');
    expect(await store.alarmFired(syncAlarm)).toBeUndefined();
    // Update now: without an update in Chrome it says so; with one it reloads into it.
    expect(await store.handle({ type: 'update' })).toMatchObject({ ok: true, noUpdate: true });
    expect(test.api.runtime.reload).not.toHaveBeenCalled();
    test.api.runtime.requestUpdateCheck.mockResolvedValueOnce({ status: 'update_available' });
    expect(await store.handle({ type: 'update' })).not.toHaveProperty('noUpdate');
    expect(test.api.runtime.reload).toHaveBeenCalledOnce();
    expect(await test.controller.handle({ type: 'update' })).toEqual({ ok: false, error: 'invalid_request' });
    // The store's new build syncs on its own again, though the manual build is newer still.
    test.getAll.mockResolvedValueOnce([{ ...cookie, value: 'changed again' }]);
    expect(await test.restart('store', '0.6.0').alarmFired(syncAlarm)).toMatchObject({ sync: { state: 'synced' } });
  });
  it('skips the upload when the digest is unchanged and uploads again after a change', async () => {
    const test = setup();
    await test.connect();
    await test.controller.handle({ type: 'capture' });
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ sync: { state: 'unchanged' } });
    expect(test.uploads()).toHaveLength(1);
    test.getAll.mockResolvedValueOnce([{ ...cookie, value: 'fixture-only-rotated' }]);
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ sync: { state: 'synced' } });
    expect(test.uploads()).toHaveLength(2);
  });
  it('never uploads excluded domains', async () => {
    const test = setup();
    await test.connect();
    await test.fromAccount({ excludedDomains: ['other.test'] });
    await test.controller.handle({ type: 'capture' });
    const { capture } = JSON.parse(test.uploads()[0]![1].body as string);
    expect(capture.cookies.map((uploaded: typeof cookie) => uploaded.domain)).toEqual(['capture.test']);
  });
  it.each([
    [403, 'forbidden', 'failed'],
    [500, 'internal', 'failed'],
    [503, 'sync_unavailable', 'unavailable'],
  ])('maps %i %s to %s, keeps the local capture, and retries on the next capture', async (code, error, state) => {
    const test = setup();
    await test.connect();
    test.fetch.mockResolvedValueOnce(failure(code, error));
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({
      ok: true,
      capture: { state: 'complete' },
      sync: { state },
      account: { state: 'syncing' },
    });
    expect(test.session()[recordKey]).toMatchObject({
      bundle: { cookies: [cookie, { ...cookie, domain: 'other.test' }] },
    });
    expect(test.local()[syncKey]).not.toHaveProperty('digest');
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ sync: { state: 'synced' } });
    expect(test.uploads()).toHaveLength(2);
  });
  it('treats network errors as failed without recording a digest', async () => {
    const test = setup();
    await test.connect();
    test.fetch.mockRejectedValueOnce(new TypeError('network'));
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ ok: true, sync: { state: 'failed' } });
    expect(test.local()[syncKey]).toEqual({ state: 'failed', connect: true });
  });
  it('schedules periodic capture while connected, clears it on pause, and recreates it on resume', async () => {
    const test = setup();
    await test.connect();
    expect(test.alarms.get(syncAlarm)).toEqual({ periodInMinutes: 1 });
    await test.controller.handle({ type: 'pause' });
    expect(test.alarms.has(syncAlarm)).toBe(false);
    await test.controller.handle({ type: 'resume' });
    expect(test.alarms.has(syncAlarm)).toBe(true);
  });
  it('does not restart an existing alarm when the worker wakes, and restores a missing one', async () => {
    const test = setup();
    await test.connect();
    test.api.alarms.create.mockClear();
    await test.restart().handle({ type: 'status' });
    expect(test.api.alarms.create).not.toHaveBeenCalled();
    test.alarms.clear();
    await test.restart().handle({ type: 'status' });
    expect(test.alarms.has(syncAlarm)).toBe(true);
    // An older build's 15-minute alarm is replaced.
    test.alarms.set(syncAlarm, { periodInMinutes: 15 });
    await test.restart().handle({ type: 'status' });
    expect(test.alarms.get(syncAlarm)).toEqual({ periodInMinutes: 1 });
  });
  it('captures and uploads when the alarm fires, and does nothing while paused', async () => {
    const test = setup();
    await test.connect();
    expect(await test.controller.alarmFired('other')).toBeUndefined();
    expect(await test.controller.alarmFired(syncAlarm)).toMatchObject({
      capture: { state: 'complete' },
      sync: { state: 'synced' },
    });
    expect(test.uploads()).toHaveLength(1);
    await test.controller.handle({ type: 'pause' });
    expect(await test.controller.alarmFired(syncAlarm)).toEqual({ ok: false, error: 'paused' });
    expect(test.uploads()).toHaveLength(1);
  });
  it('disconnect deletes the uploaded copy with the bearer token before removing access, and clears the tokens', async () => {
    const test = setup();
    await test.connect();
    await test.controller.handle({ type: 'capture' });
    const { access } = test.local()[tokensKey] as { access: string };
    let grantedDuringDelete = false;
    test.fetch.mockImplementationOnce(async () => {
      grantedDuringDelete = test.grants.size > 0;
      return new Response(null, { status: 204 });
    });
    expect(await test.controller.handle({ type: 'disconnect' })).toMatchObject({
      ok: true,
      sync: { state: 'never' },
      permissionGranted: false,
      account: { state: 'none' },
    });
    expect(test.fetch).toHaveBeenLastCalledWith(
      `${origin}/api/v1/captures`,
      expect.objectContaining({
        method: 'DELETE',
        credentials: 'omit',
        headers: expect.objectContaining({ authorization: `Bearer ${access}` }),
      }),
    );
    expect(grantedDuringDelete).toBe(true);
    // Never /oauth2/revoke, which the server refuses for the extension.
    expect(test.requests.map(({ url }) => url)).not.toContain(`${issuer}/oauth2/revoke`);
    expect(test.local()[syncKey]).toBeUndefined();
    expect(test.local()[tokensKey]).toBeUndefined();
    expect(test.local()[accountKey]).toEqual({ id: 'user-a', email: 'a@example.test' });
    expect(test.alarms.size).toBe(0);
    expect(test.badge()).toBe('');
  });
  it.each([
    ['network', () => Promise.reject(new TypeError('network'))],
    ['server error', async () => failure(500, 'internal')],
  ] as const)('still disconnects when the server delete fails (%s), and says so', async (_name, outcome) => {
    const test = setup();
    await test.connect();
    await test.controller.handle({ type: 'capture' });
    test.fetch.mockImplementationOnce(outcome);
    expect(await test.controller.handle({ type: 'disconnect' })).toMatchObject({
      ok: true,
      settings: { connected: false },
      permissionGranted: false,
      sync: { state: 'delete_failed' },
    });
    expect(test.local()[tokensKey]).toBeUndefined();
    // Chrome's permissions.onRemoved follows the removal; the notice survives it.
    await test.controller.permissionsRemoved();
    expect(await test.controller.handle({ type: 'status' })).toMatchObject({ sync: { state: 'delete_failed' } });
    expect(JSON.stringify(test.local())).not.toContain('digest');
  });
  it('sends the first upload after Connect with the reconnect flag, and never the exclusion list', async () => {
    const test = setup();
    await test.connect();
    await test.fromAccount({ excludedDomains: ['excluded.test'] });
    await test.controller.handle({ type: 'capture' });
    const first = JSON.parse(test.uploads()[0]![1].body as string);
    expect(first).toMatchObject({ connect: true, capture: { scope: { excludedDomains: [] } } });
    expect(JSON.stringify(first)).not.toContain('excluded.test');
    test.getAll.mockResolvedValueOnce([{ ...cookie, value: 'fixture-only-rotated' }]);
    await test.controller.handle({ type: 'capture' });
    expect(JSON.parse(test.uploads()[1]![1].body as string)).not.toHaveProperty('connect');
  });
  it('asks to reconnect when the server refuses the upload as disconnected, keeping grants and settings', async () => {
    const test = setup();
    await test.connect();
    await test.controller.handle({ type: 'capture' });
    test.getAll.mockResolvedValueOnce([{ ...cookie, value: 'fixture-only-rotated' }]);
    test.fetch.mockResolvedValueOnce(failure(409, 'sync_disconnected'));
    expect(await test.controller.alarmFired(syncAlarm)).toMatchObject({
      ok: true,
      settings: { connected: true, mode: 'all' },
      account: { state: 'reconnect', email: 'a@example.test' },
      permissionGranted: true,
      capture: { state: 'empty' },
    });
    expect(test.alarms.size).toBe(0);
    expect(test.badge()).toBe('!');
    expect(test.local()[tokensKey]).toBeUndefined();
    expect(JSON.stringify(test.session())).not.toContain(cookie.value);
    expect(test.fetch.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(0);
  });
  it('discards a capture queued before Pause instead of uploading it after', async () => {
    const test = setup();
    await test.connect();
    let signal!: AbortSignal;
    test.fetch.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init.signal!;
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const first = test.controller.alarmFired(syncAlarm);
    await vi.waitFor(() => expect(test.uploads()).toHaveLength(1));
    const queued = test.controller.handle({ type: 'capture' });
    const pausing = test.controller.handle({ type: 'pause' });
    expect(await first).toMatchObject({ ok: false });
    expect(await queued).toEqual({ ok: false, error: 'permission_required' });
    expect(await pausing).toMatchObject({ ok: true, settings: { paused: true } });
    expect(test.uploads()).toHaveLength(1);
    expect(test.getAll).toHaveBeenCalledTimes(1);
  });
  it.each(['disconnect', 'pause'])(
    '%s during an in-flight upload aborts it without recording success',
    async action => {
      const test = setup();
      await test.connect();
      let signal!: AbortSignal;
      test.fetch.mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            signal = init.signal!;
            signal.addEventListener('abort', () => reject(signal.reason));
          }),
      );
      const capturing = test.controller.handle({ type: 'capture' });
      await vi.waitFor(() => expect(test.uploads()).toHaveLength(1));
      expect(test.local()[syncKey]).toEqual({ state: 'uploading', connect: true });
      const stopping = test.controller.handle({ type: action });
      expect(await capturing).toEqual({ ok: false, error: 'permission_required' });
      expect(signal.aborted).toBe(true);
      // Pause keeps the record from before the upload, which is the helper's failed first upload.
      expect(await stopping).toMatchObject({ ok: true, sync: { state: action === 'pause' ? 'failed' : 'never' } });
      expect(JSON.stringify(test.local())).not.toContain('digest');
      expect(JSON.stringify(test.session())).not.toContain(cookie.value);
    },
  );
  it('runs Use added sites only at once during an in-flight upload, aborting it', async () => {
    const test = setup();
    await test.connect();
    let signal!: AbortSignal;
    test.fetch.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init.signal!;
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const capturing = test.controller.handle({ type: 'capture' });
    await vi.waitFor(() => expect(test.uploads()).toHaveLength(1));
    expect(await test.controller.handle({ type: 'narrow' })).toMatchObject({ settings: { mode: 'sites' } });
    expect(signal.aborted).toBe(true);
    await capturing;
    expect(test.uploads()).toHaveLength(1);
  });
  it('reconciles an upload interrupted by a worker restart', async () => {
    const test = setup();
    await test.connect();
    await test.api.storage.local.set({ [syncKey]: { state: 'uploading' } });
    expect(await test.restart().handle({ type: 'status' })).toMatchObject({ sync: { state: 'failed' } });
  });
  it('external revocation stops periodic capture and forgets the upload state', async () => {
    const test = setup();
    await test.connect();
    await test.controller.handle({ type: 'capture' });
    test.grants.clear();
    await test.controller.permissionsRemoved();
    expect(test.alarms.size).toBe(0);
    expect(test.local()[syncKey]).toBeUndefined();
  });
});

describe("the account's settings", () => {
  // A browser that connected to user-a before and kept its sites.
  async function withSites(sites: string[], account?: { sites: string[]; excludedDomains: string[]; paused: boolean }) {
    const test = setup();
    if (account) test.account.settings = account;
    for (const site of sites) for (const grant of siteGrants(site)) test.grants.add(grant);
    await test.api.storage.local.set({
      [settingsKey]: { consentVersion: 2, connected: false, paused: false, mode: 'sites', sites, excludedDomains: [] },
      [accountKey]: { id: 'user-a', email: 'a@example.test' },
    });
    await test.controller.handle({ type: 'connect', mode: 'sites' });
    await test.authorize();
    return test;
  }
  it("adopts this browser's sites when the account has none, and takes the account's otherwise", async () => {
    const first = await withSites(['capture.test']);
    await first.drain();
    expect(first.account.settings).toEqual({ sites: ['capture.test'], excludedDomains: [], paused: false });
    const second = await withSites(['other.test'], {
      sites: ['capture.test'],
      excludedDomains: ['bank.test'],
      paused: false,
    });
    expect(await second.drain()).toMatchObject({
      settings: { sites: ['capture.test'], excludedDomains: ['bank.test'] },
      ungrantedSites: ['capture.test'],
    });
    // Its own site left with the account's settings, and lost its grant.
    expect(second.grants.has(siteGrants('other.test')[0]!)).toBe(false);
    expect(second.account.settings).toMatchObject({ sites: ['capture.test'] });
  });
  it('pauses when the account page pauses, and only this browser resumes', async () => {
    const test = setup();
    await test.connect();
    await test.controller.handle({ type: 'capture' });
    // An upload refused as paused pauses this browser too.
    test.account.settings = { ...test.account.settings!, paused: true };
    test.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'sync_paused', settings: test.account.settings }), { status: 409 }),
    );
    test.getAll.mockResolvedValueOnce([{ ...cookie, value: 'changed' }]);
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({
      settings: { paused: true },
      capture: { state: 'empty' },
    });
    expect(test.alarms.has(syncAlarm)).toBe(false);
    expect(await test.controller.handle({ type: 'resume' })).toMatchObject({ settings: { paused: false } });
    expect(test.account.settings).toMatchObject({ paused: false });
    expect(test.alarms.has(syncAlarm)).toBe(true);
    // Resuming needs the server; pausing does not, and reaches the account at the next fetch.
    test.syncApi.mockRejectedValueOnce(new TypeError('network'));
    expect(await test.controller.handle({ type: 'pause' })).toMatchObject({ settings: { paused: true } });
    expect(test.account.settings).toMatchObject({ paused: false });
    test.syncApi.mockRejectedValueOnce(new TypeError('network'));
    expect(await test.controller.handle({ type: 'resume' })).toEqual({ ok: false, error: 'unavailable' });
    expect(await test.controller.handle({ type: 'check' })).toMatchObject({ settings: { paused: true } });
    expect(test.account.settings).toMatchObject({ paused: true });
  });
  it('asks to reconnect when the account page turns sync off, but not while connecting again', async () => {
    const test = setup();
    await test.connect();
    test.account.disconnected = true;
    // Connected and waiting for the first upload since Connect, which lifts it.
    expect(await test.controller.handle({ type: 'check' })).toMatchObject({ account: { state: 'syncing' } });
    await test.controller.handle({ type: 'capture' });
    expect(await test.controller.handle({ type: 'check' })).toMatchObject({
      settings: { connected: true },
      account: { state: 'reconnect', email: 'a@example.test' },
      permissionGranted: true,
    });
    expect(test.grants.size).toBe(2);
  });
  it("uses the server's config within fixed bounds, and fetches settings again only when due", async () => {
    const test = setup();
    await test.connect();
    expect(test.alarms.get(syncAlarm)).toEqual({ periodInMinutes: 1 });
    test.account.config = {
      syncPeriodMinutes: 0.01,
      maxUploadBytes: 10,
      settingsRefreshMinutes: 30,
      suggestedSites: [
        { name: 'Example', category: 'Tools', sites: ['example.com'], icon: '/site-icons/example.png' },
        { name: 'Tracked', category: 'Tools', sites: ['tracked.com'], icon: 'https://tracker.test/pixel.png' },
        { name: 'Broken', category: 'Tools', sites: ['not a site'] },
      ],
      companions: { 'example.com': ['example.net'] },
    };
    const status = await test.controller.handle({ type: 'check' });
    expect(status).toMatchObject({
      config: {
        syncPeriodMinutes: 1,
        maxUploadBytes: 100_000,
        settingsRefreshMinutes: 30,
        companions: { 'example.com': ['example.net'] },
        suggestedSites: [
          { name: 'Example', sites: ['example.com'], icon: '/site-icons/example.png' },
          { name: 'Tracked', sites: ['tracked.com'] },
        ],
      },
    });
    // Icons only from the Agent Computers site.
    expect((status as { config: { suggestedSites: { icon?: string }[] } }).config.suggestedSites[1]!.icon).toBe(
      undefined,
    );
    test.account.config = { syncPeriodMinutes: 5 };
    test.syncApi.mockClear();
    await test.controller.alarmFired(syncAlarm);
    expect(test.syncApi).not.toHaveBeenCalled();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 30 * 60_000);
      await test.controller.alarmFired(syncAlarm);
      expect(test.syncApi).toHaveBeenCalledTimes(1);
      expect(test.alarms.get(syncAlarm)).toEqual({ periodInMinutes: 5 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('connecting', () => {
  it('refuses a redirect that is not this flow’s, from another issuer, or malformed, without exchanging it', async () => {
    const test = setup();
    test.grant();
    const cases: [string, (code: string, state: string) => string, string][] = [
      ['a wrong state', code => test.redirect({ code, state: 'wrong', iss: issuer }), 'expired'],
      [
        'a wrong iss',
        (code, state) => test.redirect({ code, state, iss: 'https://evil.test/api/auth' }),
        'invalid_request',
      ],
      ['a missing iss', (code, state) => test.redirect({ code, state }), 'invalid_request'],
      [
        'a repeated parameter',
        (code, state) => `${test.redirect({ code, state, iss: issuer })}&state=${state}`,
        'invalid_request',
      ],
      ['code and error', (code, state) => test.redirect({ code, state, iss: issuer, error: 'x' }), 'invalid_request'],
      [
        'another page',
        (code, state) => test.redirect({ code, state, iss: issuer }).replace('connected.html', 'popup.html'),
        'invalid_request',
      ],
    ];
    for (const [name, url, error] of cases) {
      await test.controller.handle({ type: 'connect', mode: 'all' });
      const { code, state } = test.mint();
      expect(await test.exchange(url(code, state)), name).toEqual({ ok: false, error });
    }
    // An error from the server cancels the flow.
    await test.controller.handle({ type: 'connect', mode: 'all' });
    const { state } = test.mint();
    expect(await test.exchange(test.redirect({ error: 'access_denied', state, iss: issuer }))).toEqual({
      ok: false,
      error: 'denied',
    });
    expect(await test.exchange(test.redirect({ error: 'access_denied', state, iss: issuer }))).toEqual({
      ok: false,
      error: 'expired',
    });
    // An expired flow.
    await test.controller.handle({ type: 'connect', mode: 'all' });
    const late = test.redirect({ ...test.mint(), iss: issuer });
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15 * 60_000 + 1);
    expect(await test.exchange(late)).toEqual({ ok: false, error: 'expired' });
    now.mockRestore();
    expect(await test.controller.handle({ type: 'status' })).not.toHaveProperty('connecting');
    expect(test.token).not.toHaveBeenCalled();
    // A second use of the same redirect.
    await test.controller.handle({ type: 'connect', mode: 'all' });
    const used = test.redirect({ ...test.mint(), iss: issuer });
    expect(await test.exchange(used)).toMatchObject({ ok: true });
    expect(await test.exchange(used)).toEqual({ ok: false, error: 'expired' });
    expect(test.token).toHaveBeenCalledTimes(1);
  });
  it('keeps the flow usable after a redirect with a wrong state', async () => {
    const test = setup();
    await test.controller.handle({ type: 'connect', mode: 'sites' });
    const { code, state } = test.mint();
    expect(await test.exchange(test.redirect({ code, state: 'forged', iss: issuer }))).toEqual({
      ok: false,
      error: 'expired',
    });
    expect(await test.exchange(test.redirect({ code, state, iss: issuer }))).toEqual({
      ok: true,
      email: 'a@example.test',
      opener: 7,
    });
  });
  it('names the account before the first upload, which then follows, and never hands out the tokens', async () => {
    const test = setup();
    test.grant();
    const responses: unknown[] = [];
    responses.push(await test.controller.handle({ type: 'connect', mode: 'all' }));
    let release!: () => void;
    const pull = test.syncApi.getMockImplementation()!;
    test.syncApi.mockImplementationOnce(async (url, init, user) => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
      return pull(url, init, user);
    });
    const exchanged = await test.authorize();
    responses.push(exchanged);
    expect(exchanged).toEqual({ ok: true, email: 'a@example.test', opener: 7 });
    // Saved together, before the first upload.
    expect(test.local()).toMatchObject({
      [tokensKey]: { access: expect.any(String), refresh: expect.any(String) },
      [accountKey]: { id: 'user-a', email: 'a@example.test' },
      [settingsKey]: { connected: true, mode: 'all' },
      [syncKey]: { state: 'never', connect: true },
    });
    expect(test.badge()).toBe('');
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(test.uploads()).toHaveLength(0);
    release();
    const status = await test.drain();
    responses.push(status);
    expect(status).toMatchObject({ account: { state: 'syncing', email: 'a@example.test' }, sync: { state: 'synced' } });
    expect(status).not.toHaveProperty('connecting');
    expect(test.uploads()).toHaveLength(1);
    responses.push(await test.controller.handle({ type: 'capture' }));
    const { access, refresh } = test.local()[tokensKey] as { access: string; refresh: string };
    for (const response of responses) {
      expect(JSON.stringify(response)).not.toContain(access);
      expect(JSON.stringify(response)).not.toContain(refresh);
    }
  });
  it('writes nothing when /me fails after the exchange, and disconnects the tokens it got', async () => {
    const test = setup();
    await test.api.storage.local.set({ [accountKey]: { id: 'user-b', email: 'b@example.test' } });
    test.grant();
    await test.controller.handle({ type: 'connect', mode: 'all' });
    const before = structuredClone(test.local());
    test.me.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(failure(503));
    expect(await test.authorize()).toEqual({ ok: false, error: 'unavailable' });
    expect(test.me).toHaveBeenCalledTimes(2);
    expect(test.local()).toEqual(before);
    expect(test.fetch).toHaveBeenCalledWith(
      `${origin}/api/v1/captures`,
      expect.objectContaining({ method: 'DELETE', headers: { authorization: expect.stringMatching(/^Bearer /) } }),
    );
    expect(await test.drain()).toMatchObject({ settings: { connected: false }, account: { state: 'none' } });
  });
  it.each<TokenFailure>(['network', '5xx', '429', 'replay_pending'])(
    'writes nothing when the code exchange fails (%s), and spends the flow',
    async kind => {
      const test = setup();
      test.grant();
      await test.controller.handle({ type: 'connect', mode: 'all' });
      const redirect = test.redirect({ ...test.mint(), iss: issuer });
      const before = structuredClone(test.local());
      test.failNextToken(kind);
      expect(await test.exchange(redirect)).toEqual({ ok: false, error: 'unavailable' });
      expect(test.local()).toEqual(before);
      expect(await test.exchange(redirect)).toEqual({ ok: false, error: 'expired' });
      expect(test.token).toHaveBeenCalledTimes(1);
      expect(await test.drain()).toMatchObject({ settings: { connected: false }, account: { state: 'none' } });
    },
  );
  it.each([
    ['paused before the tokens ended', true],
    ['paused while it needed to reconnect', false],
  ])('keeps the pause when Reconnect resumes the same account, %s', async (_name, before) => {
    const test = setup();
    await test.connect();
    if (before) await test.controller.handle({ type: 'pause' });
    test.revokeFamily();
    // Opening the popup tells this browser the tokens ended.
    expect(await test.controller.handle({ type: 'check' })).toMatchObject({ account: { state: 'reconnect' } });
    if (!before) await test.controller.handle({ type: 'pause' });
    expect(test.account.settings).toMatchObject({ paused: before });
    await test.controller.handle({ type: 'reconnect' });
    test.fetch.mockClear();
    const from = test.requests.length;
    await test.authorize();
    expect(await test.drain()).toMatchObject({
      settings: { connected: true, paused: true },
      account: { state: 'syncing' },
    });
    expect(test.account.settings).toMatchObject({ paused: true });
    const resumed = test.requests
      .slice(from)
      .filter(({ init }) => init.method === 'PATCH' && JSON.parse(String(init.body)).paused === false);
    expect(resumed).toEqual([]);
    expect(test.alarms.has(syncAlarm)).toBe(false);
    expect(test.uploads()).toEqual([]);
  });
  it('starts fresh for a different account: drops the previous sites and their grants, keeping the new ones', async () => {
    const test = setup();
    for (const site of ['capture.test', 'other.test']) for (const grant of siteGrants(site)) test.grants.add(grant);
    await test.api.storage.local.set({
      [settingsKey]: {
        consentVersion: 2,
        connected: false,
        paused: false,
        mode: 'sites',
        sites: ['capture.test'],
        excludedDomains: ['bank.test'],
      },
      [accountKey]: { id: 'user-a', email: 'a@example.test' },
    });
    await test.controller.handle({ type: 'prepare', connect: 'sites', sites: ['other.test'] });
    await test.controller.permissionsAdded();
    expect(await test.authorize('user-b')).toEqual({ ok: true, email: 'b@example.test', opener: 7 });
    expect(await test.drain()).toMatchObject({
      settings: { connected: true, mode: 'sites', sites: ['other.test'], excludedDomains: [] },
      account: { state: 'syncing', email: 'b@example.test' },
    });
    expect(test.local()[accountKey]).toEqual({ id: 'user-b', email: 'b@example.test' });
    expect(test.accounts['user-b']!.settings).toMatchObject({ sites: ['other.test'] });
    expect([...test.grants]).toEqual(siteGrants('other.test'));
    // Revoked only after the new settings were saved.
    const saved = test.api.storage.local.set.mock.calls.findIndex(([data]) => tokensKey in data);
    const revokedAt = test.api.permissions.remove.mock.invocationCallOrder[0]!;
    expect(test.api.storage.local.set.mock.invocationCallOrder[saved]!).toBeLessThan(revokedAt);
  });
  it.each([
    ['a different account', 'user-b'],
    ['no stored account', 'user-a'],
  ])('lands a Reconnect from all sites as %s in added sites, without the all-sites grant', async (_name, user) => {
    const test = setup();
    await test.connect();
    if (user === 'user-a') await test.api.storage.local.remove(accountKey);
    test.revokeFamily();
    expect(await test.controller.alarmFired(syncAlarm)).toMatchObject({ account: { state: 'reconnect' } });
    await test.controller.handle({ type: 'reconnect' });
    await test.authorize(user);
    expect(await test.drain()).toMatchObject({
      settings: { connected: true, mode: 'sites', sites: [] },
      account: { state: 'syncing', email: emails[user] },
    });
    expect(test.api.permissions.remove).toHaveBeenCalledWith({ origins: [...browserOrigins] });
    expect(test.grants.size).toBe(0);
  });
  it('resumes the same account on Reconnect, keeping sites, exclusions and grants', async () => {
    const test = setup();
    for (const grant of siteGrants('capture.test')) test.grants.add(grant);
    await test.controller.handle({ type: 'prepare', connect: 'sites', sites: ['capture.test'] });
    await test.controller.permissionsAdded();
    await test.authorize();
    await test.drain();
    await test.fromAccount({ excludedDomains: ['bank.test'] });
    test.revokeFamily();
    test.getAll.mockResolvedValueOnce([{ ...cookie, value: 'changed' }]);
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({
      account: { state: 'reconnect', email: 'a@example.test' },
    });
    test.fetch.mockClear();
    expect(await test.controller.handle({ type: 'reconnect' })).toMatchObject({ connecting: true });
    await test.authorize();
    expect(await test.drain()).toMatchObject({
      settings: { connected: true, mode: 'sites', sites: ['capture.test'], excludedDomains: ['bank.test'] },
      account: { state: 'syncing' },
      sync: { state: 'synced' },
    });
    expect([...test.grants]).toEqual(siteGrants('capture.test'));
    expect(JSON.parse(String(test.uploads()[0]![1].body))).toMatchObject({ connect: true });
  });
  it('stops syncing when the server disconnected the browser, keeping its grants and sites, until Reconnect', async () => {
    const test = setup();
    await test.connect();
    // While syncing, Reconnect is refused and opens no tab.
    const opened = test.api.tabs.create.mock.calls.length;
    expect(await test.controller.handle({ type: 'reconnect' })).toEqual({ ok: false, error: 'invalid_request' });
    expect(test.api.tabs.create).toHaveBeenCalledTimes(opened);
    test.revokeFamily();
    expect(await test.controller.alarmFired(syncAlarm)).toMatchObject({
      settings: { connected: true, mode: 'all' },
      account: { state: 'reconnect', email: 'a@example.test' },
      permissionGranted: true,
    });
    expect(test.token).toHaveBeenCalledTimes(1);
    expect(test.alarms.has(syncAlarm)).toBe(false);
    expect(test.badge()).toBe('!');
    expect(test.grants.size).toBe(2);
    // Nothing is captured until then.
    test.getAll.mockClear();
    expect(await test.controller.alarmFired(syncAlarm)).toBeUndefined();
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ account: { state: 'reconnect' } });
    expect(await test.controller.handle({ type: 'resume' })).toEqual({ ok: false, error: 'reconnect' });
    expect(test.getAll).not.toHaveBeenCalled();
    // Reconnect asks for no grant: it only opens the tab.
    const tabs = test.api.tabs.create.mock.calls.length;
    expect(await test.controller.handle({ type: 'reconnect' })).toMatchObject({ connecting: true });
    expect(test.api.tabs.create).toHaveBeenCalledTimes(tabs + 1);
  });
  it('refreshes once after a refused access token, then retries', async () => {
    const test = setup();
    await test.connect();
    test.expireAccess();
    const before = test.requests.length;
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ sync: { state: 'synced' } });
    expect(test.token).toHaveBeenCalledTimes(1);
    expect(test.uploads()).toHaveLength(1);
    expect(test.requests.slice(before).filter(({ url }) => url === `${origin}/api/v1/captures`)).toHaveLength(2);
  });
  it('asks to reconnect without a second refresh when the retried request is refused too', async () => {
    const test = setup();
    await test.connect();
    test.refuseAccess();
    const before = test.requests.length;
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ account: { state: 'reconnect' } });
    expect(test.token).toHaveBeenCalledTimes(1);
    expect(test.requests.slice(before).filter(({ url }) => url === `${origin}/api/v1/captures`)).toHaveLength(2);
    expect(test.local()[tokensKey]).toBeUndefined();
    expect(test.badge()).toBe('!');
  });
  it('refreshes once for concurrent requests with an expiring token', async () => {
    const test = setup();
    await test.connect();
    for (const grant of siteGrants('capture.test')) test.grants.add(grant);
    const tokens = test.local()[tokensKey] as object;
    await test.api.storage.local.set({ [tokensKey]: { ...tokens, expiresAt: Date.now() } });
    await Promise.all([
      test.controller.handle({ type: 'capture' }),
      test.controller.handle({ type: 'check' }),
      test.controller.permissionsRemoved(siteGrants('capture.test')),
    ]);
    expect(test.token).toHaveBeenCalledTimes(1);
  });
  const stale = async (test: Test) => {
    const tokens = test.local()[tokensKey] as { refresh: string };
    await test.api.storage.local.set({ [tokensKey]: { ...tokens, expiresAt: Date.now() } });
    return tokens.refresh;
  };
  const presented = (test: Test) => test.token.mock.calls.map(([body]) => body.get('refresh_token'));
  // Advances fake time until the work settles, so retries scheduled later still fire.
  const settled = async <T>(work: Promise<T>) => {
    let done = false;
    void work.finally(() => {
      done = true;
    });
    while (!done) await vi.advanceTimersByTimeAsync(250);
    return work;
  };
  it(
    'retries a refresh that failed on the network with the same token',
    withFakeTimers(async () => {
      const test = setup();
      await test.connect();
      const refresh = await stale(test);
      test.failNextToken('network');
      expect(await settled(test.controller.handle({ type: 'capture' }))).toMatchObject({
        sync: { state: 'synced' },
        account: { state: 'syncing' },
      });
      expect(presented(test)).toEqual([refresh, refresh]);
    }),
  );
  it(
    'retries after a lost rotation even when the retry is refused before the server saved its answer',
    withFakeTimers(async () => {
      const test = setup();
      await test.connect();
      const refresh = await stale(test);
      test.failNextToken('lost', 'replay_pending');
      expect(await settled(test.controller.handle({ type: 'capture' }))).toMatchObject({
        sync: { state: 'synced' },
        account: { state: 'syncing' },
      });
      expect(presented(test)).toEqual([refresh, refresh, refresh]);
      expect((test.local()[tokensKey] as { refresh: string }).refresh).not.toBe(refresh);
    }),
  );
  it('asks to reconnect when the first refresh attempt is refused', async () => {
    const test = setup();
    await test.connect();
    await stale(test);
    test.failNextToken('replay_pending');
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ account: { state: 'reconnect' } });
    expect(test.token).toHaveBeenCalledTimes(1);
    expect(test.uploads()).toHaveLength(0);
  });
  it('keeps the tokens when the token endpoint is rate limited', async () => {
    const test = setup();
    await test.connect();
    const refresh = await stale(test);
    test.failNextToken('429');
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({
      sync: { state: 'failed' },
      account: { state: 'syncing' },
    });
    expect(test.token).toHaveBeenCalledTimes(1);
    expect((test.local()[tokensKey] as { refresh: string }).refresh).toBe(refresh);
  });
  it(
    'keeps the tokens when every refresh attempt fails, and stops trying inside the reuse window',
    withFakeTimers(async () => {
      const test = setup();
      await test.connect();
      const refresh = await stale(test);
      test.failNextToken('network', '5xx', 'network', 'network', 'network');
      // When each attempt starts, not when the capture settles: settled() advances the clock in steps while the
      // capture also waits on real event-loop turns, so a busy machine overshoots the end by whole steps.
      const starts: number[] = [];
      const request = test.token.getMockImplementation()!;
      test.token.mockImplementation(async body => {
        starts.push(Date.now());
        return request(body);
      });
      expect(await settled(test.controller.handle({ type: 'capture' }))).toMatchObject({
        sync: { state: 'failed' },
        account: { state: 'syncing' },
      });
      // Attempts at 0, 1, 4 and 9 seconds; a fifth would start past refreshRetryMs (20 s), so none does.
      expect(starts).toHaveLength(4);
      const gaps = starts.slice(1).map((at, index) => at - starts[index]!);
      expect(gaps.map((gap, index) => gap >= [1_000, 3_000, 5_000][index]!)).toEqual([true, true, true]);
      expect(starts.at(-1)! - starts[0]!).toBeLessThan(refreshRetryMs);
      expect((test.local()[tokensKey] as { refresh: string }).refresh).toBe(refresh);
    }),
  );
  it('shows Reconnect once for an install updated from a build that synced with the web sign-in', async () => {
    const test = setup();
    test.grant();
    test.alarms.set(syncAlarm, { periodInMinutes: 1 });
    await test.api.storage.local.set({
      [settingsKey]: {
        consentVersion: 2,
        connected: true,
        paused: false,
        mode: 'all',
        sites: [],
        excludedDomains: ['bank.test'],
      },
      [accountKey]: { id: 'user-a', email: 'a@example.test' },
      [syncKey]: { state: 'signed_out', connect: true },
    });
    const updated = test.restart();
    expect(await updated.handle({ type: 'status' })).toMatchObject({
      settings: { connected: true, mode: 'all', excludedDomains: ['bank.test'] },
      account: { state: 'reconnect', email: 'a@example.test' },
      sync: { state: 'failed' },
      permissionGranted: true,
    });
    expect(test.alarms.has(syncAlarm)).toBe(false);
    expect(test.badge()).toBe('!');
    expect(await updated.alarmFired(syncAlarm)).toBeUndefined();
    expect(test.getAll).not.toHaveBeenCalled();
    expect(test.requests).toEqual([]);
    // Without tokens, Disconnect cannot confirm the deletion.
    expect(await updated.handle({ type: 'disconnect' })).toMatchObject({
      settings: { connected: false },
      sync: { state: 'delete_failed' },
    });
  });
  it('reports an unconfirmed deletion when the server refuses the tokens on Disconnect', async () => {
    const test = setup();
    await test.connect();
    test.revokeFamily();
    expect(await test.controller.handle({ type: 'disconnect' })).toMatchObject({
      settings: { connected: false },
      account: { state: 'none' },
      sync: { state: 'delete_failed' },
      permissionGranted: false,
    });
    expect(test.local()[tokensKey]).toBeUndefined();
    expect(test.badge()).toBe('');
  });
  it('opens a tab when connecting with tokens the server no longer accepts', async () => {
    const test = setup();
    await test.connect();
    // All-sites access removed in Chrome disconnects locally but keeps the tokens.
    test.grants.clear();
    await test.controller.permissionsRemoved([...browserOrigins]);
    expect(await test.controller.handle({ type: 'status' })).toMatchObject({ settings: { connected: false } });
    test.revokeFamily();
    test.grant();
    const tabs = test.api.tabs.create.mock.calls.length;
    expect(await test.controller.handle({ type: 'connect', mode: 'all' })).toMatchObject({ connecting: true });
    expect(test.api.tabs.create).toHaveBeenCalledTimes(tabs + 1);
    await test.authorize();
    expect(await test.drain()).toMatchObject({ settings: { connected: true, mode: 'all' }, sync: { state: 'synced' } });
  });
  it('connects with added sites when the all-sites grant went before the redirect, keeping the tokens', async () => {
    const test = setup();
    test.grant();
    await test.controller.handle({ type: 'connect', mode: 'all' });
    test.grants.clear();
    await test.authorize();
    expect(await test.drain()).toMatchObject({
      settings: { connected: true, mode: 'sites' },
      account: { state: 'syncing' },
    });
    expect(test.local()[tokensKey]).toBeDefined();
  });
});
