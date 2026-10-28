import { createHash } from 'node:crypto';
import {
  applySyncChange,
  browserOrigins,
  refreshRetryMs,
  type StatusResponse,
  type SyncSettings,
  serverProofPath,
} from '@clutchbox/capture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountKey,
  alarmOf,
  type CaptureBrowser,
  CaptureController,
  type ConnectionEntry,
  connectionsKey,
  type Distribution,
  keyOf,
  recordKey,
  settingsKey,
  syncAlarm,
  syncKey,
  tokensKey,
  trustedSender,
} from './controller';

const origin = 'https://server.test';
const issuer = `${origin}/api/auth`;
// A server other than the build's, run by someone else.
const elsewhere = 'https://agents.elsewhere.test';
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
// `installed`: local storage as a build from before connections left it, which startup moves to the first connection.
function setup(installed: { [key: string]: unknown } = {}) {
  let session: { [key: string]: unknown } = {};
  let local: { [key: string]: unknown } = structuredClone(installed);
  const grants = new Set<string>();
  const getAll = vi.fn(async () => [cookie, { ...cookie, domain: 'other.test' }]);
  const alarms = new Map<string, { periodInMinutes: number } | { when: number }>();
  // POST and DELETE /api/v1/captures, once the bearer token is accepted.
  const fetch = vi.fn(async (_url: string, init: RequestInit) =>
    init.method === 'DELETE' ? new Response(null, { status: 204 }) : accepted(),
  );
  // GET /api/v1/me for the token's owner: every organization they belong to (`memberships`), the first one first,
  // and the one a request naming none acts in, the one they acted in on the server's website when they connected
  // (`acting`).
  const organizations: { [id: string]: string } = { 'org-a': 'Acme', 'org-b': 'Beta', 'org-x': 'Elsewhere' };
  const acting: { [user: string]: string } = { 'user-a': 'org-a', 'user-b': 'org-a' };
  const memberships: { [user: string]: string[] } = { 'user-a': ['org-a'], 'user-b': ['org-a'] };
  const me = vi.fn(async (user: string, organization: string) =>
    answer(200, {
      user: { id: user, email: emails[user], name: 'A' },
      organization: { id: organization, name: organizations[organization] },
      organizations: (memberships[user] ?? []).map(id => ({ id, name: organizations[id] })),
      defaultOrganization: memberships[user]?.[0] ?? null,
    }),
  );
  // Each membership's sync settings (/api/v1/sync): a small fake of the server's rules. A person's membership in
  // org-a is named for them alone, and in any other organization `<user>@<organization>`.
  type Account = { settings: SyncSettings | null; disconnected: boolean; config?: unknown };
  const accounts: { [user: string]: Account } = {
    'user-a': { settings: null, disconnected: false },
    'user-b': { settings: null, disconnected: false },
  };
  const account = accounts['user-a']!;
  const memberOf = (user: string, organization: string) =>
    organization === 'org-a' ? user : `${user}@${organization}`;
  const syncApi = vi.fn(async (url: string, init: RequestInit, user: string) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    accounts[user] ??= { settings: null, disconnected: false };
    const theirs = accounts[user];
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
  // The server's OAuth rules the extension relies on, as packages/api's extension-oauth tests prove them for the web
  // app: single-use codes bound to the PKCE challenge and redirect URI; rotating refresh tokens whose rotated token gets the same answer for 30 seconds and
  // disconnects its family after; a disconnected family's tokens refused.
  let counter = 0;
  const codes = new Map<
    string,
    { user: string; organization: string; challenge: string; redirectUri: string; server: string }
  >();
  // Each token works only on the server that issued it.
  type Holder = { user: string; organization: string; family: string; server: string };
  const accessTokens = new Map<string, Holder>();
  const refreshTokens = new Map<string, Holder & { rotatedAt?: number; answer?: object }>();
  const revoked = new Set<string>();
  const failures: TokenFailure[] = [];
  // Set by refuseAccess: access tokens minted from then on are refused too.
  let refuseIssued = false;
  const issue = ({ user, organization, family, server }: Holder) => {
    counter++;
    const tokens = {
      access_token: `access-${counter}`,
      token_type: 'Bearer',
      expires_in: 300,
      refresh_token: `refresh-${counter}`,
      scope: 'offline_access sync',
    };
    if (!refuseIssued) accessTokens.set(tokens.access_token, { user, organization, family, server });
    refreshTokens.set(tokens.refresh_token, { user, organization, family, server });
    return tokens;
  };
  const invalidGrant = () => answer(400, { error: 'invalid_grant' });
  const grantTokens = (body: URLSearchParams, server: string) => {
    if (body.get('client_id') !== 'agent-computers-extension') return answer(401, { error: 'invalid_client' });
    if (body.get('grant_type') === 'authorization_code') {
      const code = codes.get(body.get('code') ?? '');
      codes.delete(body.get('code') ?? '');
      const challenge = createHash('sha256')
        .update(body.get('code_verifier') ?? '')
        .digest('base64url');
      if (
        !code ||
        code.server !== server ||
        code.redirectUri !== body.get('redirect_uri') ||
        code.challenge !== challenge
      )
        return invalidGrant();
      return answer(
        200,
        issue({ user: code.user, organization: code.organization, family: `family-${counter + 1}`, server }),
      );
    }
    const presented = refreshTokens.get(body.get('refresh_token') ?? '');
    if (!presented || presented.server !== server || revoked.has(presented.family)) return invalidGrant();
    if (presented.answer) {
      if (Date.now() - presented.rotatedAt! <= 30_000) return answer(200, presented.answer);
      revoked.add(presented.family);
      return invalidGrant();
    }
    presented.answer = issue(presented);
    presented.rotatedAt = Date.now();
    return answer(200, presented.answer);
  };
  const token = vi.fn(async (body: URLSearchParams, server = origin) => {
    const failure = failures.shift();
    if (failure === 'network') throw new TypeError('network');
    if (failure === '5xx') return answer(503, { error: 'server_error' });
    if (failure === '429') return answer(429, { error: 'rate_limited' });
    if (failure === 'replay_pending') return invalidGrant();
    const response = grantTokens(body, server);
    if (failure === 'lost') throw new TypeError('network');
    return response;
  });
  const bearer = (init: RequestInit, server: string) => {
    const presented = /^Bearer (.+)$/.exec(
      (init.headers as { [name: string]: string } | undefined)?.authorization ?? '',
    );
    const found = presented ? accessTokens.get(presented[1]!) : undefined;
    return found && found.server === server && !revoked.has(found.family) ? found : undefined;
  };
  const requests: { url: string; init: RequestInit }[] = [];
  // The captures each organization accepted.
  const received: { organization: string; capture: { scope: unknown; cookies: { domain: string }[] } }[] = [];
  // The build's server's verified list, asked for without a token.
  const verified = vi.fn(async () => answer(200, { servers: [] as { origin: string; name: string }[] }));
  // Each server's proof file, naming the address it signs people in at: an alias's names the server it stands for.
  const aliases: { [alias: string]: string } = {};
  const route = async (url: string, init: RequestInit = {}) => {
    requests.push({ url, init });
    if (init.credentials !== 'omit') credentialed.push(url);
    const server = new URL(url).origin;
    if (url === `${origin}/api/v1/verified-servers`) return verified();
    if (url === `${server}${serverProofPath}`) return answer(200, { origin: aliases[server] ?? server });
    if (url === `${server}/api/auth/oauth2/token`) return token(new URLSearchParams(String(init.body)), server);
    const caller = bearer(init, server);
    if (!caller) return failure(401, 'unauthenticated');
    if (url === `${server}/api/v1/me`) return me(caller.user, caller.organization);
    // Each request acts in the organization it names, which the person must belong to.
    const named = (init.headers as { [name: string]: string } | undefined)?.['x-organization'];
    if (named !== undefined && !memberships[caller.user]?.includes(named)) return failure(403, 'not_a_member');
    const organization = named ?? caller.organization;
    if (url.startsWith(`${server}/api/v1/sync`)) return syncApi(url, init, memberOf(caller.user, organization));
    const response = await fetch(url, init);
    if (init.method === 'POST' && response.ok)
      received.push({ organization, capture: JSON.parse(String(init.body)).capture });
    // DELETE /captures signs out the browser that sent it.
    if (url === `${server}/api/v1/captures` && init.method === 'DELETE' && response.ok) revoked.add(caller.family);
    return response;
  };
  const remove = (area: () => { [key: string]: unknown }, assign: (next: { [key: string]: unknown }) => void) =>
    vi.fn(async (keys: string | string[]) => {
      const next = { ...area() };
      for (const key of [keys].flat()) delete next[key];
      assign(next);
    });
  // Chrome Enterprise policy for the extension.
  let managed: { [key: string]: unknown } = {};
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
      managed: { get: vi.fn(async () => structuredClone(managed)) },
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
  const authorizeRequest = (server = origin) => {
    const url = new URL(api.tabs.create.mock.calls.at(-1)![0].url);
    expect(`${url.origin}${url.pathname}`).toBe(`${server}/api/auth/oauth2/authorize`);
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
  const mint = (user = 'user-a', server = origin) => {
    const { state, challenge } = authorizeRequest(server);
    const code = `code-${++counter}`;
    codes.set(code, { user, organization: acting[user]!, challenge, redirectUri, server });
    return { code, state };
  };
  const exchange = (url: string) => controller.handle({ type: 'exchange', url });
  const redirect = (params: { [name: string]: string }) => `${redirectUri}?${new URLSearchParams(params)}`;
  const authorize = (user = 'user-a', server = origin) =>
    exchange(redirect({ ...mint(user, server), iss: `${server}/api/auth` }));
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
  // The first connection's ID, and its stored values; the tokens and account are its server's.
  const first = () => (local[connectionsKey] as ConnectionEntry[])[0]!.id;
  const perServer = (key: string) => key === tokensKey || key === accountKey;
  const named = (data: { [key: string]: unknown }) =>
    Object.fromEntries(
      Object.entries(data).map(([key, value]) => [keyOf(key, perServer(key) ? origin : first()), value]),
    );
  return {
    controller,
    restart,
    first,
    entries: () => (local[connectionsKey] as ConnectionEntry[] | undefined) ?? [],
    stored: (key: string) => local[keyOf(key, perServer(key) ? origin : first())],
    record: () => session[keyOf(recordKey, first())],
    alarm: () => alarmOf(first()),
    write: (data: { [key: string]: unknown }) => api.storage.local.set(named(data)),
    writeSession: (data: { [key: string]: unknown }) => api.storage.session.set(named(data)),
    api,
    grants,
    getAll,
    alarms,
    fetch,
    me,
    token,
    account,
    accounts,
    acting,
    memberships,
    received,
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
    authorizeRequest,
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
    verified,
    aliases,
    policy: (next: { [key: string]: unknown }) => {
      managed = next;
    },
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
  it("refuses excluded sites and the Clutchbox site, and the account's exclusion removes an added site", async () => {
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
    // Signing out leaves no connection to reconnect.
    expect(await test.controller.handle({ type: 'disconnect' })).toMatchObject({
      connections: [],
      settings: { connected: false },
      account: { state: 'none' },
    });
    expect(await test.controller.handle({ type: 'reconnect' })).toEqual({ ok: false, error: 'permission_required' });
    for (const grant of siteGrants('capture.test')) test.grants.add(grant);
    // Signing in again opens a tab, and the organization keeps its sites.
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
    expect(await test.authorize()).toEqual({ ok: true, email: 'a@example.test', organization: 'Acme', opener: 3 });
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
  it('starts an install from before accounts fresh, keeping its grants', async () => {
    const test = setup({
      [settingsKey]: { consentVersion: 1, connected: true, paused: false, excludedDomains: ['other.test'] },
      [tokensKey]: { access: 'old', refresh: 'old', expiresAt: Date.now() + 3600_000 },
      latestVersion: '9.9.9',
    });
    test.grant();
    expect(await test.controller.handle({ type: 'status' })).toMatchObject({
      connections: [],
      settings: { connected: false, mode: 'sites', sites: [], excludedDomains: [] },
      account: { state: 'none' },
      permissionGranted: true,
    });
    expect(test.local()).toEqual({ latestVersion: '9.9.9', storageLayout: 2 });
    expect(test.grants.size).toBeGreaterThan(0);
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
    expect(test.record()).toMatchObject({
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
    expect(test.alarms.get(test.alarm())).toEqual({ periodInMinutes: 1 });
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
    expect(test.record()).toMatchObject({ bundle: { cookies: [{ ...cookie, domain: 'other.test' }] } });
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
  it('Sign out removes all granted origins including old fixture grants, while the account keeps its exclusions', async () => {
    const test = setup();
    await test.connect();
    test.grants.add('https://*.capture.test/*');
    test.grants.add(`${origin}/*`);
    await test.fromAccount({ excludedDomains: ['other.test'] });
    await test.controller.handle({ type: 'capture' });
    expect(await test.controller.handle({ type: 'disconnect' })).toMatchObject({
      connections: [],
      settings: { connected: false },
      permissionGranted: false,
    });
    expect(test.grants.size).toBe(0);
    // The organization keeps its exclusions for the next sign-in.
    expect(test.account.settings).toMatchObject({ excludedDomains: ['other.test'] });
    expect(JSON.stringify(test.session())).not.toContain(cookie.value);
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ ok: false });
  });
  it('signs out even if Chrome permission removal fails, offering to remove the access left', async () => {
    const test = setup();
    await test.connect();
    test.api.permissions.remove.mockRejectedValueOnce(new Error('removal failed'));
    expect(await test.controller.handle({ type: 'disconnect' })).toMatchObject({ connections: [] });
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ ok: false });
    expect(test.entries()).toEqual([]);
    expect(test.local()[keyOf(tokensKey, origin)]).toBeUndefined();
    expect(await test.controller.handle({ type: 'status' })).toMatchObject({
      permissionGranted: true,
      settings: { connected: false },
    });
    expect(await test.controller.handle({ type: 'disconnect' })).toMatchObject({ permissionGranted: false });
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
    expect(test.record()).toMatchObject({ status: { state: 'failed' } });
  });
  it('reconciles a capture interrupted by a worker restart instead of reporting it complete', async () => {
    const test = setup();
    await test.connect();
    await test.writeSession({ [recordKey]: { status: { state: 'capturing' } } });
    expect(await test.restart().handle({ type: 'status' })).toMatchObject({ capture: { state: 'interrupted' } });
  });
  it('accepts the popup and the setup tab, the redirect page for the exchange only, and rejects others', () => {
    const page = (path: string, extra: object = {}) => ({ id: 'own', url: `chrome-extension://own/${path}`, ...extra });
    const tab = { tab: { id: 4 } as chrome.tabs.Tab, frameId: 0 };
    const status = { type: 'status' };
    const exchange = { type: 'exchange', url: `${redirectUri}?code=x` };
    expect(trustedSender(page('popup.html'), 'own', status)).toBe(true);
    expect(trustedSender(page('setup.html', tab), 'own', status)).toBe(true);
    expect(trustedSender(page('setup.html#server', tab), 'own', status)).toBe(true);
    expect(trustedSender(page('connected.html', tab), 'own', exchange)).toBe(true);
    expect(trustedSender(page('connected.html?code=x&state=y', tab), 'own', exchange)).toBe(true);
    for (const [sender, message] of [
      [{ id: 'own', url: 'https://capture.test/' }, status],
      [page('setup.html?x'), status],
      [page('setup.html#other'), status],
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

describe('sync to the server', () => {
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
        authorization: `Bearer ${(test.stored(tokensKey) as { access: string }).access}`,
      },
    });
    expect(JSON.parse(init.body as string).capture.cookies).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('digest');
    expect(test.stored(syncKey)).toMatchObject({ state: 'synced', digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
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
    expect(test.record()).toMatchObject({
      bundle: { cookies: [cookie, { ...cookie, domain: 'other.test' }] },
    });
    expect(test.stored(syncKey)).not.toHaveProperty('digest');
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ sync: { state: 'synced' } });
    expect(test.uploads()).toHaveLength(2);
  });
  it('treats network errors as failed without recording a digest', async () => {
    const test = setup();
    await test.connect();
    test.fetch.mockRejectedValueOnce(new TypeError('network'));
    expect(await test.controller.handle({ type: 'capture' })).toMatchObject({ ok: true, sync: { state: 'failed' } });
    expect(test.stored(syncKey)).toEqual({ state: 'failed', connect: true });
  });
  it('schedules periodic capture while connected, clears it on pause, and recreates it on resume', async () => {
    const test = setup();
    await test.connect();
    expect(test.alarms.get(test.alarm())).toEqual({ periodInMinutes: 1 });
    await test.controller.handle({ type: 'pause' });
    expect(test.alarms.has(test.alarm())).toBe(false);
    await test.controller.handle({ type: 'resume' });
    expect(test.alarms.has(test.alarm())).toBe(true);
  });
  it('does not restart an existing alarm when the worker wakes, and restores a missing one', async () => {
    const test = setup();
    await test.connect();
    test.api.alarms.create.mockClear();
    await test.restart().handle({ type: 'status' });
    expect(test.api.alarms.create).not.toHaveBeenCalled();
    test.alarms.clear();
    await test.restart().handle({ type: 'status' });
    expect(test.alarms.has(test.alarm())).toBe(true);
    // An older build's 15-minute alarm is replaced.
    test.alarms.set(test.alarm(), { periodInMinutes: 15 });
    await test.restart().handle({ type: 'status' });
    expect(test.alarms.get(test.alarm())).toEqual({ periodInMinutes: 1 });
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
  it('Sign out deletes the uploads with the bearer token before removing access, and forgets the server', async () => {
    const test = setup();
    await test.connect();
    await test.controller.handle({ type: 'capture' });
    const { access } = test.stored(tokensKey) as { access: string };
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
    // It names no organization: it signs the browser out of all of them.
    expect(test.fetch.mock.lastCall![1].headers).not.toHaveProperty('x-organization');
    expect(test.entries()).toEqual([]);
    expect(Object.keys(test.local()).filter(key => key.includes(':'))).toEqual([]);
    expect(test.alarms.size).toBe(0);
    expect(test.badge()).toBe('');
  });
  it.each([
    ['network', () => Promise.reject(new TypeError('network'))],
    ['server error', async () => failure(500, 'internal')],
  ] as const)(
    'still signs out when the server delete fails (%s), and says so until the next sign-in',
    async (_name, outcome) => {
      const test = setup();
      await test.connect();
      await test.controller.handle({ type: 'capture' });
      test.fetch.mockImplementationOnce(outcome);
      expect(await test.controller.handle({ type: 'disconnect' })).toMatchObject({
        ok: true,
        connections: [],
        permissionGranted: false,
        signOutFailed: origin,
      });
      expect(test.local()[keyOf(tokensKey, origin)]).toBeUndefined();
      // Chrome's permissions.onRemoved follows the removal; the notice survives it.
      await test.controller.permissionsRemoved();
      expect(await test.controller.handle({ type: 'status' })).toMatchObject({ signOutFailed: origin });
      expect(JSON.stringify(test.local())).not.toContain('digest');
      await test.controller.handle({ type: 'connect', mode: 'sites' });
      await test.authorize();
      expect(await test.drain()).not.toHaveProperty('signOutFailed');
    },
  );
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
  it('stops syncing to an organization that removed this browser, staying signed in, until it syncs there again', async () => {
    const test = setup();
    await test.connect();
    await test.controller.handle({ type: 'capture' });
    test.getAll.mockResolvedValueOnce([{ ...cookie, value: 'fixture-only-rotated' }]);
    test.fetch.mockResolvedValueOnce(failure(409, 'sync_disconnected'));
    expect(await test.controller.alarmFired(syncAlarm)).toMatchObject({
      ok: true,
      settings: { connected: false, mode: 'sites' },
      sync: { state: 'removed' },
      account: { state: 'syncing', email: 'a@example.test' },
      permissionGranted: false,
      capture: { state: 'revoked' },
    });
    expect(test.alarms.size).toBe(0);
    expect(test.badge()).toBe('');
    expect(test.stored(tokensKey)).toBeDefined();
    expect(JSON.stringify(test.session())).not.toContain(cookie.value);
    expect(test.fetch.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(0);
    // Syncing there again needs no new sign-in, and its first upload lifts the removal.
    for (const grant of siteGrants('capture.test')) test.grants.add(grant);
    await test.controller.handle({ type: 'connect', mode: 'sites' });
    expect(test.api.tabs.create).toHaveBeenCalledTimes(1);
    expect(await test.controller.handle({ type: 'sites', sites: ['capture.test'] })).toMatchObject({
      settings: { connected: true, sites: ['capture.test'] },
      sync: { state: 'synced' },
    });
    expect(JSON.parse(test.uploads().at(-1)![1].body as string)).toMatchObject({ connect: true });
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
      expect(test.stored(syncKey)).toEqual({ state: 'uploading', connect: true });
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
    await test.write({ [syncKey]: { state: 'uploading' } });
    expect(await test.restart().handle({ type: 'status' })).toMatchObject({ sync: { state: 'failed' } });
  });
  it('external revocation stops periodic capture and forgets the upload state', async () => {
    const test = setup();
    await test.connect();
    await test.controller.handle({ type: 'capture' });
    test.grants.clear();
    await test.controller.permissionsRemoved();
    expect(test.alarms.size).toBe(0);
    expect(test.stored(syncKey)).toBeUndefined();
  });
});

describe("the account's settings", () => {
  // Signing in with Agree and add <site>.
  async function withSites(sites: string[], account?: { sites: string[]; excludedDomains: string[]; paused: boolean }) {
    const test = setup();
    if (account) test.account.settings = account;
    await test.controller.handle({ type: 'prepare', connect: 'sites', sites });
    for (const site of sites) for (const grant of siteGrants(site)) test.grants.add(grant);
    await test.controller.handle({ type: 'finish' });
    await test.authorize();
    return test;
  }
  it("adds the click's sites to the organization's, adopting them when it has none", async () => {
    const first = await withSites(['capture.test']);
    await first.drain();
    expect(first.account.settings).toEqual({ sites: ['capture.test'], excludedDomains: [], paused: false });
    const second = await withSites(['other.test'], {
      sites: ['capture.test'],
      excludedDomains: ['bank.test'],
      paused: false,
    });
    expect(await second.drain()).toMatchObject({
      settings: { sites: ['capture.test', 'other.test'], excludedDomains: ['bank.test'] },
      ungrantedSites: ['capture.test'],
    });
    expect(second.grants.has(siteGrants('other.test')[0]!)).toBe(true);
    expect(second.account.settings).toMatchObject({ sites: ['capture.test', 'other.test'] });
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
    expect(test.alarms.has(test.alarm())).toBe(false);
    expect(await test.controller.handle({ type: 'resume' })).toMatchObject({ settings: { paused: false } });
    expect(test.account.settings).toMatchObject({ paused: false });
    expect(test.alarms.has(test.alarm())).toBe(true);
    // Resuming needs the server; pausing does not, and reaches the account at the next fetch.
    test.syncApi.mockRejectedValueOnce(new TypeError('network'));
    expect(await test.controller.handle({ type: 'pause' })).toMatchObject({ settings: { paused: true } });
    expect(test.account.settings).toMatchObject({ paused: false });
    test.syncApi.mockRejectedValueOnce(new TypeError('network'));
    expect(await test.controller.handle({ type: 'resume' })).toEqual({ ok: false, error: 'unavailable' });
    expect(await test.controller.handle({ type: 'check' })).toMatchObject({ settings: { paused: true } });
    expect(test.account.settings).toMatchObject({ paused: true });
  });
  it('stops syncing to the organization when its page turns sync off, but not while syncing there again', async () => {
    const test = setup();
    await test.connect();
    test.account.disconnected = true;
    // Connected and waiting for the first upload since Connect, which lifts it.
    expect(await test.controller.handle({ type: 'check' })).toMatchObject({ settings: { connected: true } });
    await test.controller.handle({ type: 'capture' });
    expect(await test.controller.handle({ type: 'check' })).toMatchObject({
      settings: { connected: false },
      sync: { state: 'removed' },
      account: { state: 'syncing', email: 'a@example.test' },
      permissionGranted: false,
    });
    expect(test.grants.size).toBe(0);
    expect(test.stored(tokensKey)).toBeDefined();
  });
  it("uses the server's config within fixed bounds, and fetches settings again only when due", async () => {
    const test = setup();
    await test.connect();
    expect(test.alarms.get(test.alarm())).toEqual({ periodInMinutes: 1 });
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
    // Icons only from the Clutchbox site.
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
      expect(test.alarms.get(test.alarm())).toEqual({ periodInMinutes: 5 });
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
      organization: 'Acme',
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
    expect(exchanged).toEqual({ ok: true, email: 'a@example.test', organization: 'Acme', opener: 7 });
    // Saved before the first upload.
    expect(test.entries()).toEqual([{ id: test.first(), origin, organization: { id: 'org-a', name: 'Acme' } }]);
    expect(test.local()).toMatchObject({
      [keyOf(tokensKey, origin)]: { access: expect.any(String), refresh: expect.any(String) },
      [keyOf(accountKey, origin)]: { id: 'user-a', email: 'a@example.test' },
      [keyOf(settingsKey, test.first())]: { connected: true, mode: 'all' },
      [keyOf(syncKey, test.first())]: { state: 'never', connect: true },
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
    const { access, refresh } = test.stored(tokensKey) as { access: string; refresh: string };
    for (const response of responses) {
      expect(JSON.stringify(response)).not.toContain(access);
      expect(JSON.stringify(response)).not.toContain(refresh);
    }
  });
  it('writes nothing when /me fails after the exchange, and disconnects the tokens it got', async () => {
    const test = setup({ [accountKey]: { id: 'user-b', email: 'b@example.test' } });
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
    expect(test.alarms.has(test.alarm())).toBe(false);
    expect(test.uploads()).toEqual([]);
  });
  it('starts fresh when Reconnect lands in a different account: drops the previous connections and their grants', async () => {
    const test = setup();
    for (const grant of siteGrants('capture.test')) test.grants.add(grant);
    await test.controller.handle({ type: 'prepare', connect: 'sites', sites: ['capture.test'] });
    await test.controller.permissionsAdded();
    await test.authorize();
    await test.drain();
    const previous = test.first();
    test.revokeFamily();
    expect(await test.controller.handle({ type: 'check' })).toMatchObject({ account: { state: 'reconnect' } });
    await test.controller.handle({ type: 'reconnect' });
    expect(await test.authorize('user-b')).toEqual({
      ok: true,
      email: 'b@example.test',
      organization: 'Acme',
      opener: 7,
    });
    expect(await test.drain()).toMatchObject({
      settings: { connected: true, mode: 'sites', sites: [], excludedDomains: [] },
      account: { state: 'syncing', email: 'b@example.test' },
    });
    expect(test.first()).not.toBe(previous);
    expect(test.entries()).toHaveLength(1);
    expect(test.stored(accountKey)).toEqual({ id: 'user-b', email: 'b@example.test' });
    expect(test.accounts['user-a']!.settings).toMatchObject({ sites: ['capture.test'] });
    expect(test.grants.size).toBe(0);
  });
  it.each([
    ['a different account', 'user-b'],
    ['no stored account', 'user-a'],
  ])('lands a Reconnect from all sites as %s in added sites, without the all-sites grant', async (_name, user) => {
    const test = setup();
    await test.connect();
    if (user === 'user-a') await test.api.storage.local.remove(keyOf(accountKey, origin));
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
    expect(test.alarms.has(test.alarm())).toBe(false);
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
    expect(test.stored(tokensKey)).toBeUndefined();
    expect(test.badge()).toBe('!');
  });
  it('refreshes once for concurrent requests with an expiring token', async () => {
    const test = setup();
    await test.connect();
    for (const grant of siteGrants('capture.test')) test.grants.add(grant);
    const tokens = test.stored(tokensKey) as object;
    await test.write({ [tokensKey]: { ...tokens, expiresAt: Date.now() } });
    await Promise.all([
      test.controller.handle({ type: 'capture' }),
      test.controller.handle({ type: 'check' }),
      test.controller.permissionsRemoved(siteGrants('capture.test')),
    ]);
    expect(test.token).toHaveBeenCalledTimes(1);
  });
  const stale = async (test: Test) => {
    const tokens = test.stored(tokensKey) as { refresh: string };
    await test.write({ [tokensKey]: { ...tokens, expiresAt: Date.now() } });
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
      expect((test.stored(tokensKey) as { refresh: string }).refresh).not.toBe(refresh);
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
    expect((test.stored(tokensKey) as { refresh: string }).refresh).toBe(refresh);
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
      expect((test.stored(tokensKey) as { refresh: string }).refresh).toBe(refresh);
    }),
  );
  it('reports an unconfirmed deletion when the server refuses the tokens on Sign out', async () => {
    const test = setup();
    await test.connect();
    test.revokeFamily();
    expect(await test.controller.handle({ type: 'disconnect' })).toMatchObject({
      connections: [],
      account: { state: 'none' },
      signOutFailed: origin,
      permissionGranted: false,
    });
    expect(test.local()[keyOf(tokensKey, origin)]).toBeUndefined();
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
    expect(test.stored(tokensKey)).toBeDefined();
  });
});

describe('several organizations', () => {
  const add = async (test: Test, connection: string, sites: string[]) => {
    for (const site of sites) for (const grant of siteGrants(site)) test.grants.add(grant);
    const status = (await test.controller.handle({ type: 'status', connection })) as StatusResponse;
    return test.controller.handle({ type: 'sites', sites: [...status.settings.sites, ...sites], connection });
  };
  const remove = async (test: Test, connection: string, site: string) => {
    const status = (await test.controller.handle({ type: 'status', connection })) as StatusResponse;
    return test.controller.handle({
      type: 'sites',
      sites: status.settings.sites.filter(each => each !== site),
      connection,
    });
  };
  const domains = (test: Test, organization: string) =>
    test.received
      .filter(each => each.organization === organization)
      .at(-1)
      ?.capture.cookies.map(each => each.domain);
  // The organizations each request named.
  const named = (test: Test) =>
    test.requests
      .map(({ init }) => (init.headers as { [name: string]: string } | undefined)?.['x-organization'])
      .filter(Boolean);
  // One Chrome profile signed in to an account in org-a and org-b.
  async function twoOrganizations() {
    const test = setup();
    test.memberships['user-a'] = ['org-a', 'org-b'];
    await test.controller.handle({ type: 'connect', mode: 'sites' });
    await test.authorize();
    await test.drain();
    const [a, b] = test.entries().map(entry => entry.id) as [string, string];
    return { test, a, b };
  }

  it('connects every organization of the account in one sign-in, and sends each site only to the one it was added to', async () => {
    const { test, a, b } = await twoOrganizations();
    expect(test.entries()).toEqual([
      { id: a, origin, organization: { id: 'org-a', name: 'Acme' } },
      { id: b, origin, organization: { id: 'org-b', name: 'Beta' } },
    ]);
    expect(test.api.tabs.create).toHaveBeenCalledTimes(1);
    await add(test, a, ['capture.test']);
    await add(test, b, ['other.test']);
    expect(domains(test, 'org-a')).toEqual(['capture.test']);
    expect(domains(test, 'org-b')).toEqual(['other.test']);
    expect(new Set(named(test))).toEqual(new Set(['org-a', 'org-b']));
    expect(test.accounts['user-a']!.settings).toMatchObject({ sites: ['capture.test'] });
    expect(test.accounts['user-a@org-b']!.settings).toMatchObject({ sites: ['other.test'] });
    // Each organization has its own periodic capture, which captures only its own sites.
    expect(test.alarms.has(alarmOf(a))).toBe(true);
    expect(test.alarms.has(alarmOf(b))).toBe(true);
    test.getAll.mockResolvedValue([
      { ...cookie, value: 'changed' },
      { ...cookie, domain: 'other.test', value: 'changed' },
    ]);
    test.received.length = 0;
    await test.controller.alarmFired(alarmOf(b));
    expect(test.received.map(each => each.organization)).toEqual(['org-b']);
    expect(domains(test, 'org-b')).toEqual(['other.test']);
    expect(await test.controller.handle({ type: 'status', connection: b })).toMatchObject({
      connection: b,
      settings: { sites: ['other.test'] },
      account: { state: 'syncing', email: 'a@example.test' },
      connections: [
        { id: a, origin, organization: { name: 'Acme' }, settings: { sites: ['capture.test'] } },
        { id: b, origin, organization: { name: 'Beta' }, settings: { sites: ['other.test'] } },
      ],
    });
    // The popup opens on the organization it showed last, even after the worker restarts.
    expect(await test.controller.handle({ type: 'status' })).toMatchObject({ connection: b });
    await settle();
    expect(await test.restart().handle({ type: 'status' })).toMatchObject({ connection: b });
    expect(await test.controller.handle({ type: 'status', connection: 'unknown' })).toEqual({
      ok: false,
      error: 'invalid_request',
    });
  });
  it("shows the account's first organization after signing in, whatever the web app is acting in", async () => {
    const test = setup();
    test.memberships['user-a'] = ['org-b', 'org-a'];
    test.acting['user-a'] = 'org-a';
    await test.controller.handle({ type: 'connect', mode: 'sites' });
    expect(await test.authorize()).toMatchObject({ ok: true, organization: 'Beta' });
    const [first] = test.entries();
    expect(first!.organization).toEqual({ id: 'org-b', name: 'Beta' });
    expect(await test.drain()).toMatchObject({ connection: first!.id, settings: { connected: true } });
  });
  it('pauses one organization, leaving the other syncing, and Sign out ends both', async () => {
    const { test, a, b } = await twoOrganizations();
    await add(test, a, ['capture.test']);
    await add(test, b, ['other.test']);
    expect(await test.controller.handle({ type: 'pause', connection: a })).toMatchObject({
      settings: { paused: true },
    });
    expect(test.account.settings).toMatchObject({ paused: true });
    expect(test.accounts['user-a@org-b']!.settings).toMatchObject({ paused: false });
    expect(test.alarms.has(alarmOf(a))).toBe(false);
    expect(test.alarms.has(alarmOf(b))).toBe(true);
    expect(await test.controller.handle({ type: 'capture', connection: a })).toEqual({ ok: false, error: 'paused' });
    test.getAll.mockResolvedValue([{ ...cookie, domain: 'other.test', value: 'changed' }]);
    expect(await test.controller.handle({ type: 'capture', connection: b })).toMatchObject({
      sync: { state: 'synced' },
    });
    expect(await test.controller.handle({ type: 'resume', connection: a })).toMatchObject({
      settings: { paused: false },
    });
    test.fetch.mockClear();
    expect(await test.controller.handle({ type: 'disconnect', connection: b })).toMatchObject({ connections: [] });
    expect(test.fetch.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(1);
    expect(test.grants.size).toBe(0);
    expect(test.alarms.size).toBe(0);
  });
  it('stops syncing to an organization that removed this browser, keeping the other and the grants it uses', async () => {
    const { test, a, b } = await twoOrganizations();
    await add(test, a, ['capture.test', 'other.test']);
    await add(test, b, ['other.test']);
    test.accounts['user-a']!.disconnected = true;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
    test.getAll.mockResolvedValue([{ ...cookie, value: 'changed' }]);
    expect(await test.controller.handle({ type: 'capture', connection: a })).toMatchObject({
      settings: { connected: false },
      sync: { state: 'removed' },
      account: { state: 'syncing' },
    });
    expect([...test.grants]).toEqual(siteGrants('other.test'));
    expect(test.badge()).toBe('');
    expect(await test.controller.handle({ type: 'status', connection: b })).toMatchObject({
      settings: { connected: true, sites: ['other.test'] },
    });
  });
  it("keeps a site's grant while another organization uses it, and a site revoked in Chrome leaves every one", async () => {
    const { test, a, b } = await twoOrganizations();
    await add(test, a, ['capture.test', 'other.test']);
    await add(test, b, ['capture.test']);
    await remove(test, a, 'capture.test');
    expect(test.grants.has(siteGrants('capture.test')[0]!)).toBe(true);
    await remove(test, b, 'capture.test');
    expect(test.grants.has(siteGrants('capture.test')[0]!)).toBe(false);
    await add(test, b, ['other.test']);
    for (const grant of siteGrants('other.test')) test.grants.delete(grant);
    await test.controller.permissionsRemoved(siteGrants('other.test'));
    for (const connection of [a, b])
      expect(await test.controller.handle({ type: 'status', connection })).toMatchObject({
        settings: { connected: true, sites: [] },
      });
    expect(test.account.settings).toMatchObject({ sites: [] });
    expect(test.accounts['user-a@org-b']!.settings).toMatchObject({ sites: [] });
  });
  it('adds organizations the account joins and drops the ones it leaves, with their grants', async () => {
    const { test, a, b } = await twoOrganizations();
    await add(test, b, ['other.test']);
    expect(await test.controller.handle({ type: 'status', connection: b })).toMatchObject({ connection: b });
    test.memberships['user-a'] = ['org-a', 'org-x'];
    const opened = (await test.controller.handle({ type: 'check' })) as StatusResponse;
    const x = test.entries().find(entry => entry.organization?.id === 'org-x')!.id;
    expect(test.entries().map(entry => entry.id)).toEqual([a, x]);
    // The one it showed is gone, so it shows the first.
    expect(opened).toMatchObject({ connection: a });
    expect(opened.connections.find(each => each.id === x)).toMatchObject({
      settings: { connected: true, mode: 'sites', sites: [] },
    });
    expect(test.grants.size).toBe(0);
    expect(test.alarms.has(alarmOf(b))).toBe(false);
    expect(test.alarms.has(alarmOf(x))).toBe(true);
    expect(Object.keys(test.local()).filter(key => key.endsWith(b))).toEqual([]);
  });
  it('fetches the organizations again when a request names one the account has left', async () => {
    const { test, a, b } = await twoOrganizations();
    await add(test, b, ['other.test']);
    test.memberships['user-a'] = ['org-a'];
    test.getAll.mockResolvedValue([{ ...cookie, domain: 'other.test', value: 'changed' }]);
    await test.controller.handle({ type: 'capture', connection: b });
    await test.drain();
    expect(test.entries().map(entry => entry.id)).toEqual([a]);
    expect(test.grants.size).toBe(0);
  });
  it('lands Reconnect in the organization it came from, keeping every organization as it was', async () => {
    const { test, a, b } = await twoOrganizations();
    await add(test, a, ['capture.test']);
    await test.controller.handle({ type: 'pause', connection: a });
    await add(test, b, ['other.test']);
    test.revokeFamily();
    expect(await test.controller.handle({ type: 'check' })).toMatchObject({ account: { state: 'reconnect' } });
    expect(test.badge()).toBe('!');
    const tabs = test.api.tabs.create.mock.calls.length;
    await test.controller.handle({ type: 'reconnect', connection: b });
    expect(test.api.tabs.create).toHaveBeenCalledTimes(tabs + 1);
    expect(await test.authorize()).toMatchObject({ ok: true, organization: 'Beta' });
    expect(await test.drain()).toMatchObject({ connection: b, settings: { connected: true, sites: ['other.test'] } });
    expect(test.entries().map(entry => entry.id)).toEqual([a, b]);
    expect(await test.controller.handle({ type: 'status', connection: a })).toMatchObject({
      settings: { connected: true, paused: true, sites: ['capture.test'] },
      account: { state: 'syncing' },
    });
    expect(test.badge()).toBe('');
  });
  it('keeps the all-sites grant while another organization captures all sites', async () => {
    const { test, a, b } = await twoOrganizations();
    test.grant();
    await test.controller.handle({ type: 'connect', mode: 'all', connection: a });
    await add(test, b, ['other.test']);
    test.accounts['user-a@org-b']!.disconnected = true;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
    test.getAll.mockResolvedValue([{ ...cookie, domain: 'other.test', value: 'changed' }]);
    expect(await test.controller.handle({ type: 'capture', connection: b })).toMatchObject({
      settings: { connected: false },
    });
    expect(test.grants.has(browserOrigins[0])).toBe(true);
    expect(await test.controller.handle({ type: 'status', connection: a })).toMatchObject({
      settings: { connected: true, mode: 'all' },
    });
  });
  it('syncs to the one organization a server from before accounts names, naming none in its requests', async () => {
    const test = setup();
    test.me.mockImplementation(async (user: string, organization: string) =>
      answer(200, {
        user: { id: user, email: emails[user], name: 'A' },
        organization: { id: organization, name: 'Acme' },
      }),
    );
    for (const grant of siteGrants('capture.test')) test.grants.add(grant);
    await test.controller.handle({ type: 'prepare', connect: 'sites', sites: ['capture.test'] });
    await test.controller.permissionsAdded();
    await test.authorize();
    expect(await test.drain()).toMatchObject({ settings: { sites: ['capture.test'] }, sync: { state: 'synced' } });
    expect(test.entries()).toEqual([
      { id: expect.any(String), origin, organization: { id: 'org-a', name: 'Acme' }, legacy: true },
    ]);
    expect(named(test)).toEqual([]);
  });
});

describe('another server', () => {
  const trust = (test: Test, server: string) => test.controller.handle({ type: 'server', origin: server });
  const opened = (test: Test) => test.api.tabs.create.mock.calls.length;

  it('warns for a server outside the verified list, unless it is the build’s, verified, approved, or connected', async () => {
    const test = setup();
    expect(await trust(test, origin)).toEqual({ ok: true, origin, trust: 'build' });
    expect(await trust(test, 'agents.elsewhere.test/some/page')).toEqual({
      ok: true,
      origin: elsewhere,
      trust: 'unverified',
    });
    // The list comes from the build's server, without cookies or anything else about the person.
    const asked = test.requests.filter(({ url }) => url === `${origin}/api/v1/verified-servers`);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.init).toEqual({ credentials: 'omit', signal: expect.any(AbortSignal) });
    test.verified.mockResolvedValueOnce(answer(200, { servers: [{ origin: elsewhere, name: 'Elsewhere Inc' }] }));
    expect(await trust(test, elsewhere)).toEqual({
      ok: true,
      origin: elsewhere,
      trust: 'verified',
      name: 'Elsewhere Inc',
    });
    // Unreachable or malformed, the built-in copy decides.
    test.verified.mockRejectedValueOnce(new TypeError('network'));
    expect(await trust(test, elsewhere)).toMatchObject({ trust: 'unverified' });
    test.verified.mockResolvedValueOnce(answer(503, { error: 'service_unavailable' }));
    expect(await trust(test, 'https://www.clutchbox.dev')).toEqual({
      ok: true,
      origin: 'https://www.clutchbox.dev',
      trust: 'verified',
      name: 'Clutchbox',
    });
    test.verified.mockResolvedValueOnce(answer(200, { servers: [{ origin: 'http://plain.test', name: 'Plain' }] }));
    expect(await trust(test, 'http://plain.test')).toEqual({ ok: false, error: 'invalid_request' });
    // The browser's administrator approves servers through policy, which needs no request.
    test.policy({ approvedServers: ['https://agents.elsewhere.test/', 42] });
    test.verified.mockClear();
    expect(await trust(test, elsewhere)).toEqual({ ok: true, origin: elsewhere, trust: 'policy' });
    expect(test.verified).not.toHaveBeenCalled();
    for (const invalid of ['http://agents.elsewhere.test', 'not a server', 'https://user:pw@agents.elsewhere.test', ''])
      expect(await trust(test, invalid)).toEqual({ ok: false, error: 'invalid_request' });
  });

  it('signs in to another server only after its warning, and syncs its organizations to it alone', async () => {
    const test = setup();
    const before = opened(test);
    // Refused before Chrome's prompt and before any tab, whether or not the click needs a grant.
    expect(await test.controller.handle({ type: 'connect', mode: 'sites', another: true, origin: elsewhere })).toEqual({
      ok: false,
      error: 'unverified_server',
    });
    expect(
      await test.controller.handle({
        type: 'prepare',
        connect: 'sites',
        sites: ['capture.test'],
        another: true,
        origin: elsewhere,
      }),
    ).toEqual({ ok: false, error: 'unverified_server' });
    expect(test.session().pendingGrant).toBeUndefined();
    expect(opened(test)).toBe(before);
    // Agreed: the grant, then the server's authorize page.
    expect(
      await test.controller.handle({
        type: 'prepare',
        connect: 'sites',
        sites: ['capture.test'],
        another: true,
        origin: elsewhere,
        warned: true,
      }),
    ).toMatchObject({ ok: true });
    for (const grant of siteGrants('capture.test')) test.grants.add(grant);
    await test.controller.permissionsAdded();
    // A redirect naming another issuer than the flow's server is refused.
    const { code, state } = test.mint('user-a', elsewhere);
    expect(await test.exchange(test.redirect({ code, state, iss: issuer }))).toEqual({
      ok: false,
      error: 'invalid_request',
    });
    expect(test.entries()).toEqual([]);
    await test.controller.handle({
      type: 'connect',
      mode: 'sites',
      another: true,
      origin: elsewhere,
      warned: true,
    });
    test.memberships['user-a'] = ['org-x'];
    expect(await test.authorize('user-a', elsewhere)).toMatchObject({ ok: true, organization: 'Elsewhere' });
    await test.drain();
    const [entry] = test.entries();
    expect(entry).toEqual({
      id: expect.any(String),
      origin: elsewhere,
      organization: { id: 'org-x', name: 'Elsewhere' },
    });
    // Its sync and settings go to that server only.
    for (const grant of siteGrants('capture.test')) test.grants.add(grant);
    await test.controller.handle({ type: 'sites', sites: ['capture.test'], connection: entry!.id });
    test.getAll.mockResolvedValue([{ ...cookie, value: 'changed' }]);
    expect(await test.controller.handle({ type: 'capture', connection: entry!.id })).toMatchObject({
      origin: elsewhere,
      sync: { state: 'synced' },
    });
    const servers = new Set(
      test.requests
        .map(({ url }) => new URL(url))
        .filter(url => url.pathname !== '/api/v1/verified-servers')
        .map(url => url.origin),
    );
    expect([...servers]).toEqual([elsewhere]);
    expect(test.accounts['user-a@org-x']!.settings).toMatchObject({ sites: ['capture.test'] });
    // Connected once, it needs no warning again.
    expect(await trust(test, elsewhere)).toMatchObject({ trust: 'connected' });
  });

  it('signs in at the address a server names, so an alias of it does not fail the issuer check', async () => {
    const test = setup();
    const alias = 'https://alias.elsewhere.test';
    test.aliases[alias] = elsewhere;
    expect(await trust(test, `${alias}/some/page`)).toMatchObject({ ok: true, origin: elsewhere });
    // Asked without cookies.
    const asked = test.requests.find(({ url }) => url === `${alias}${serverProofPath}`);
    expect(asked!.init).toMatchObject({ credentials: 'omit' });
    await test.controller.handle({ type: 'connect', mode: 'sites', another: true, origin: alias, warned: true });
    test.memberships['user-a'] = ['org-x'];
    expect(await test.authorize('user-a', elsewhere)).toMatchObject({ ok: true, organization: 'Elsewhere' });
    expect(test.entries()).toMatchObject([{ origin: elsewhere }]);
    // A server whose proof file is missing or malformed keeps the address as typed.
    test.aliases[alias] = 'not a server';
    expect(await trust(test, alias)).toMatchObject({ ok: true, origin: alias });
  });

  it('connects a verified or approved server without the warning', async () => {
    const test = setup();
    test.verified.mockResolvedValue(answer(200, { servers: [{ origin: elsewhere, name: 'Elsewhere Inc' }] }));
    expect(
      await test.controller.handle({ type: 'connect', mode: 'sites', another: true, origin: elsewhere }),
    ).toMatchObject({ ok: true });
    test.authorizeRequest(elsewhere);
    test.verified.mockResolvedValue(answer(200, { servers: [] }));
    test.policy({ approvedServers: [elsewhere] });
    expect(
      await test.controller.handle({ type: 'connect', mode: 'sites', another: true, origin: elsewhere }),
    ).toMatchObject({ ok: true });
    test.authorizeRequest(elsewhere);
  });
});
