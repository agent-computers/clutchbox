import {
  type AccountState,
  authorizeUrl,
  browserOrigins,
  builtInVerifiedServers,
  type Capture,
  type CaptureMode,
  type CaptureRequest,
  type CaptureSettings,
  type CaptureStatus,
  type ConnectionSummary,
  captureDigest,
  captureSchema,
  compareVersions,
  cookieExcluded,
  cookieInSites,
  defaultSettings,
  type ExchangeResponse,
  type ExtensionConfig,
  extensionVersionHeader,
  flowTtlMs,
  issuerOf,
  meSchema,
  newState,
  type Organization,
  organizationHeader,
  organizationSchema,
  parseExtensionConfig,
  parseSettings,
  pkce,
  type Response,
  readRedirect,
  refreshAheadMs,
  refreshAttemptMs,
  refreshDeadlineMs,
  refreshRetryMs,
  requestSchema,
  requestTokens,
  type ServerResponse,
  type StatusResponse,
  type SyncChange,
  type SyncRecord,
  type SyncSettings,
  type SyncTokens,
  serverOriginOfInput,
  serverProofPath,
  serverProofSchema,
  siteOfHost,
  siteOrigins,
  sitesOfOrigins,
  syncRecordSchema,
  syncResponseSchema,
  syncSettingsSchema,
  type TokenResult,
  timeoutSignal,
  uploadResultSchema,
  type VerifiedServer,
  verifiedServersPath,
  verifiedServersSchema,
  within,
} from '@agent-computers/capture';

// The extension signs in to one account on each server, and holds a list of connections, one for each organization
// of that account (local storage). Each connection keeps its own copy of the keys below, named
// `<key>:<connection ID>` (keyOf), and its own periodic capture. `legacy`: the server lists no organizations (it
// predates accounts), so its one connection's requests name none.
export const connectionsKey = 'connections';
export type ConnectionEntry = { id: string; origin: string; organization?: Organization; legacy?: true };
export const keyOf = (key: string, connection: string) => `${key}:${connection}`;
export const recordKey = 'captureRecord';
export const settingsKey = 'captureSettings';
export const syncKey = 'syncState';
// The server's config, when the extension last fetched its settings, and sites Chrome revoked that the
// server has not yet been told about (local storage).
export const configKey = 'extensionConfig';
export const pulledKey = 'settingsPulledAt';
export const revokedKey = 'revokedSites';
// Each server's OAuth tokens and the account they belong to, named `<key>:<server origin>` (local storage). The account
// is kept while its tokens wait for Reconnect, so reconnecting as a different account can start fresh.
export const tokensKey = 'syncTokens';
export const accountKey = 'syncAccount';
const connectionKeys = [settingsKey, syncKey, configKey, pulledKey, revokedKey];
// The connection the popup shows, kept between openings; and a Sign out whose deletion the server did not confirm.
export const selectedKey = 'selectedConnection';
export const signOutFailedKey = 'signOutFailed';
// Installs from before accounts kept tokens per connection (or, before connections, under the bare keys); startup
// starts them fresh, keeping Chrome's grants, and marks the storage with this layout.
export const layoutKey = 'storageLayout';
const layout = 2;
// For the whole extension: the build the servers offer, and the build a server last refused as outdated, which the
// periodic capture waits on until this build changes.
export const latestVersionKey = 'latestVersion';
export const refusedVersionKey = 'refusedVersion';
export const pendingKey = 'pendingGrant';
// A connect flow waiting for the server's tab: its state and PKCE verifier (session storage).
export const flowKey = 'oauthFlow';
// Chrome's prompt closes the popup on some platforms, so the click's purpose waits here for the grant. `tab` is the
// page it came from, which the connect tab returns to.
export const pendingTtlMs = 120_000;
type Pending = {
  connect?: CaptureMode;
  sites: string[];
  at: number;
  tab?: number;
  connection?: string;
  another?: true;
  // Signing in to a server (the build's, or `origin`), and whether the person agreed to its warning.
  origin?: string;
  warned?: true;
};
// `sites` are added once connected; `reconnect` resumes a server whose tokens ended. `connection` is the one the
// click came from, if any, where the exchange lands when the account still has it.
type Flow = {
  state: string;
  verifier: string;
  at: number;
  mode: CaptureMode;
  sites: string[];
  reconnect: boolean;
  opener?: number;
  origin?: string;
  connection?: string;
};
// Each connection's periodic capture, which uploads only on change, is the alarm `capture-sync:<connection ID>`
// (alarmOf); `capture-sync` itself, which Chrome's startup fires, runs every connection's. Its period, the quick
// capture's timings after sign-ins and sign-outs, and the upload cap come from the server's config (ExtensionConfig),
// within fixed bounds.
export const syncAlarm = 'capture-sync';
export const alarmOf = (connection: string) => `${syncAlarm}:${connection}`;
const uploadTimeoutMs = 60_000;
const deleteTimeoutMs = 10_000;
const checkTimeoutMs = 10_000;
// Refresh retry delays; refreshRetryMs bounds them (oss/packages/capture/src/oauth.ts).
const refreshDelaysMs = [1_000, 3_000, 5_000];
type Record = { status: CaptureStatus; bundle?: Capture };
type ChangedCookie = Parameters<typeof cookieExcluded>[0] & { name: string; path: string };
export type CookieChange = { cookie: ChangedCookie; removed: boolean; cause: string };
const cookieKey = (cookie: ChangedCookie) =>
  JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey?.topLevelSite ?? null]);
type Account = { id: string; email: string };
// `organizations` is every one the account belongs to, and `first` the one to show first; a server from before
// accounts lists none (`legacy`), and its one connection is the organization the token acts in, if it names one.
type Me = { account: Account; organizations: Organization[]; first?: string; legacy: boolean };
type Access = string | 'reconnect' | 'unavailable';
type StorageArea = Pick<typeof chrome.storage.session, 'get' | 'set' | 'remove' | 'setAccessLevel'>;
// Chrome Enterprise policy for this extension (managed-schema.json): `approvedServers` connect without the warning.
export const approvedServersKey = 'approvedServers';
// Chrome Web Store builds update through Chrome and offer added sites only; manual (unpacked) builds update by hand from
// the server's account page and also offer all sites.
export type Distribution = 'store' | 'manual';
export interface CaptureBrowser {
  permissions: Pick<typeof chrome.permissions, 'contains' | 'remove' | 'getAll'>;
  cookies: Pick<typeof chrome.cookies, 'getAll'>;
  storage: { session: StorageArea; local: StorageArea; managed: Pick<typeof chrome.storage.managed, 'get'> };
  alarms: {
    get(name: string): Promise<{ periodInMinutes?: number } | undefined>;
    create(name: string, info: { periodInMinutes: number } | { when: number }): Promise<void>;
    clear(name: string): Promise<boolean>;
  };
  tabs: Pick<typeof chrome.tabs, 'create' | 'query' | 'get'>;
  action: Pick<typeof chrome.action, 'setBadgeText'>;
  runtime: Pick<typeof chrome.runtime, 'requestUpdateCheck' | 'reload'>;
  fetch: typeof fetch;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const isTokens = (value: unknown): value is SyncTokens =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as SyncTokens).access === 'string' &&
  typeof (value as SyncTokens).refresh === 'string' &&
  typeof (value as SyncTokens).expiresAt === 'number';
const isEntry = (value: unknown): value is ConnectionEntry =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ConnectionEntry).id === 'string' &&
  typeof (value as ConnectionEntry).origin === 'string' &&
  ((value as ConnectionEntry).organization === undefined ||
    organizationSchema.safeParse((value as ConnectionEntry).organization).success);
function readMe(body: unknown): Me | undefined {
  const me = meSchema.safeParse(body);
  if (!me.success) return undefined;
  const { user, organization, organizations, defaultOrganization } = me.data;
  const listed = organizations ?? (organization ? [organization] : []);
  const first = defaultOrganization ?? listed[0]?.id;
  return {
    account: { id: user.id, email: user.email },
    organizations: listed,
    legacy: organizations === undefined,
    ...(first ? { first } : {}),
  };
}
// The account behind an access token, and its organizations. Retried once after a network error or 5xx.
async function meAt(fetcher: typeof fetch, origin: string, access: string): Promise<Me | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(1_000);
    try {
      const response = await fetcher(`${origin}/api/v1/me`, {
        credentials: 'omit',
        headers: { authorization: `Bearer ${access}` },
        signal: AbortSignal.timeout(checkTimeoutMs),
      });
      const me = response.ok ? readMe(await response.json().catch(() => undefined)) : undefined;
      if (me) return me;
      if (response.status < 500) return undefined;
    } catch {
      // Retried below.
    }
  }
  return undefined;
}

// What every connection shares: the browser, the build, one queue for all work, and Chrome's grants, which belong to
// the whole extension.
interface Host {
  api: CaptureBrowser;
  version: string;
  distribution: Distribution;
  redirectUri: string;
  enqueue<T>(work: () => Promise<T>): Promise<T>;
  handle(request: CaptureRequest): Promise<Response | ExchangeResponse | ServerResponse>;
  // What the other connections still use: sites they capture while connected, and whether one captures all sites.
  others(connection: string): Promise<{ sites: Set<string>; all: boolean }>;
  // Every connection's server site, which no connection captures.
  serverSites(): string[];
  badge(): Promise<void>;
  startFlow(flow: Pick<Flow, 'mode' | 'sites' | 'reconnect' | 'origin' | 'connection'>, from?: number): Promise<void>;
  server(origin: string): Server;
  // A server's tokens ended: every connection on it waits for Reconnect.
  endTokens(origin: string): Promise<void>;
  // A request named an organization the account has left: the list is fetched again.
  organizationsChanged(origin: string): void;
  signOut(origin: string): Promise<void>;
}

// One server's account: its tokens, which every connection on that server shares and refreshes one at a time, and
// every request to it.
class Server {
  private refreshing: Promise<Access> | undefined;
  constructor(
    private readonly host: Host,
    readonly origin: string,
  ) {}
  private get api() {
    return this.host.api;
  }
  async tokens(): Promise<SyncTokens | undefined> {
    const stored = (await this.api.storage.local.get(keyOf(tokensKey, this.origin)))[keyOf(tokensKey, this.origin)];
    return isTokens(stored) ? stored : undefined;
  }
  async account(): Promise<Account | undefined> {
    return (await this.api.storage.local.get(keyOf(accountKey, this.origin)))[keyOf(accountKey, this.origin)] as
      | Account
      | undefined;
  }
  // An access token for a server request: the stored one, refreshed when it is about to expire.
  private async accessToken(): Promise<Access> {
    const tokens = await this.tokens();
    if (!tokens) return 'reconnect';
    if (tokens.expiresAt - Date.now() > refreshAheadMs) return tokens.access;
    return this.refresh();
  }
  // One refresh at a time: concurrent callers share it, since a second one would present a rotated token.
  refresh(): Promise<Access> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  // Retries an attempt whose outcome is unknown while the server still answers the old token with the same tokens.
  // `invalid_grant` ends the tokens, unless an earlier attempt may have rotated the token: the server refuses a
  // retry that arrives before it has saved the answer to replay. Anything else keeps the tokens.
  private async doRefresh(): Promise<Access> {
    const tokens = await this.tokens();
    if (!tokens) return 'reconnect';
    const start = Date.now();
    let uncertain = false;
    let last: TokenResult = 'retry';
    for (let attempt = 0; ; attempt++) {
      const timeout = timeoutSignal(Math.min(refreshAttemptMs, start + refreshDeadlineMs - Date.now()));
      try {
        last = await requestTokens(this.api.fetch, this.origin, { refreshToken: tokens.refresh }, timeout.signal);
      } finally {
        timeout.clear();
      }
      if (typeof last === 'object') {
        // Saved before anything else, so the rotated token is never lost. Tokens that ended or changed meanwhile
        // (Sign out, a new sign-in) are kept.
        const current = await this.tokens();
        if (current?.refresh !== tokens.refresh) return current?.access ?? 'reconnect';
        await this.api.storage.local.set({ [keyOf(tokensKey, this.origin)]: last.tokens });
        return last.tokens.access;
      }
      if (last === 'unavailable') return 'unavailable';
      if (last === 'invalid_grant' && !uncertain) break;
      if (last === 'retry') uncertain = true;
      const delay = refreshDelaysMs[attempt];
      if (delay === undefined || Date.now() - start + delay >= refreshRetryMs) break;
      await sleep(delay);
    }
    if (last !== 'invalid_grant') return 'unavailable';
    if ((await this.tokens())?.refresh === tokens.refresh) await this.host.endTokens(this.origin);
    return 'reconnect';
  }
  // Every request to the server: the bearer token, never cookies (no grant on its site, so credentialed CORS would
  // fail), naming the organization it acts in. A 401 on a bearer request means the token was refused, as when signing
  // out on the server's website revokes the current access token: refresh once and retry. Throws when the server can't
  // be reached for a token.
  async call(
    path: string,
    init: RequestInit,
    organization?: string | undefined,
  ): Promise<globalThis.Response | 'reconnect'> {
    const token = await this.accessToken();
    if (token === 'reconnect') return 'reconnect';
    if (token === 'unavailable') throw new Error('unavailable');
    const send = (access: string) =>
      this.api.fetch(`${this.origin}${path}`, {
        ...init,
        credentials: 'omit',
        headers: {
          ...(init.headers as { [name: string]: string } | undefined),
          ...(organization === undefined ? {} : { [organizationHeader]: organization }),
          authorization: `Bearer ${access}`,
        },
      });
    let response = await send(token);
    if (response.status === 401) {
      const stored = await this.tokens();
      if (!stored) return 'reconnect';
      // A concurrent call may have refreshed already.
      const next = stored.access === token ? await this.refresh() : stored.access;
      if (next === 'reconnect') return 'reconnect';
      if (next === 'unavailable') throw new Error('unavailable');
      response = await send(next);
      if (response.status === 401) {
        await this.host.endTokens(this.origin);
        return 'reconnect';
      }
    }
    if (response.status === 403 && organization !== undefined) {
      const body = (await response
        .clone()
        .json()
        .catch(() => undefined)) as { error?: unknown } | undefined;
      if (body?.error === 'not_a_member') this.host.organizationsChanged(this.origin);
    }
    return response;
  }
  // The account and its organizations, as the server names them now.
  async me(): Promise<Me | 'reconnect' | undefined> {
    try {
      const response = await this.call('/api/v1/me', { signal: AbortSignal.timeout(checkTimeoutMs) });
      if (response === 'reconnect') return 'reconnect';
      return response.ok ? readMe(await response.json().catch(() => undefined)) : undefined;
    } catch {
      return undefined;
    }
  }
}

// One organization on one server: its settings, capture, sync record and periodic capture, synced as the account
// signed in to that server. The controller queues its work, so nothing here runs concurrently with other work.
class Connection {
  epoch = 0;
  private upload: AbortController | undefined;
  // The last capture's cookie keys, read from session storage when first needed after it changes.
  private captured: Set<string> | undefined;
  private quickTimer: ReturnType<typeof setTimeout> | undefined;
  private quickStart: number | undefined;
  private quickAt = 0;
  readonly alarm: string;
  constructor(
    private readonly host: Host,
    readonly id: string,
    readonly origin: string,
    // The organization's ID, which every request names; none on a server from before accounts.
    readonly organization: string | undefined,
  ) {
    this.alarm = alarmOf(id);
  }
  private get api() {
    return this.host.api;
  }
  private get server() {
    return this.host.server(this.origin);
  }
  private key(name: string) {
    return keyOf(name, this.id);
  }

  async initialize() {
    const record = await this.read();
    const settings = await this.settings();
    if (!settings.connected || settings.paused || (record.bundle && !captureSchema.safeParse(record.bundle).success)) {
      await this.save({ status: { state: 'empty' } });
    } else if (record.status.state === 'capturing') {
      await this.save({ status: { state: 'interrupted' } });
    }
    const sync = await this.syncRecord();
    if (sync.state === 'uploading') await this.saveSync({ ...sync, state: 'failed' });
    // Connected without tokens: the server's tokens ended. It waits for Reconnect.
    const reconnect = settings.connected && !(await this.tokens());
    if (!settings.connected || settings.paused || reconnect) await this.api.alarms.clear(this.alarm);
    // Recreating an existing alarm would restart its period on every worker wake. One from an older build's period
    // is replaced.
    else if ((await this.api.alarms.get(this.alarm))?.periodInMinutes !== (await this.config()).syncPeriodMinutes)
      await this.schedule();
  }
  private async read(): Promise<Record> {
    const data = await this.api.storage.session.get(this.key(recordKey));
    return (data[this.key(recordKey)] as Record | undefined) ?? { status: { state: 'empty' } };
  }
  async settings(): Promise<CaptureSettings> {
    const data = await this.api.storage.local.get(this.key(settingsKey));
    return parseSettings(data[this.key(settingsKey)]);
  }
  private async syncRecord(): Promise<SyncRecord> {
    const data = await this.api.storage.local.get(this.key(syncKey));
    // Records from removed states: the invite gate and the web sign-in become failed, keeping the reconnect flag but
    // not the digest; a dashboard disconnect, which now ends the tokens, starts over.
    const stored = data[this.key(syncKey)] as { state?: unknown; connect?: unknown } | undefined;
    const parsed = syncRecordSchema.safeParse(
      stored?.state === 'not_invited' || stored?.state === 'signed_out'
        ? { state: 'failed', ...(stored.connect === true ? { connect: true } : {}) }
        : stored?.state === 'disconnected'
          ? { state: 'never' }
          : stored,
    );
    return parsed.success ? parsed.data : { state: 'never' };
  }
  private save(record: Record) {
    this.captured = undefined;
    return this.api.storage.session.set({ [this.key(recordKey)]: record });
  }
  private saveSettings(settings: CaptureSettings) {
    return this.api.storage.local.set({ [this.key(settingsKey)]: settings });
  }
  private saveSync(record: SyncRecord) {
    return this.api.storage.local.set({ [this.key(syncKey)]: record });
  }
  tokens(): Promise<SyncTokens | undefined> {
    return this.server.tokens();
  }
  private async schedule() {
    await this.api.alarms.create(this.alarm, { periodInMinutes: (await this.config()).syncPeriodMinutes });
  }
  private async config(): Promise<ExtensionConfig> {
    return parseExtensionConfig((await this.api.storage.local.get(this.key(configKey)))[this.key(configKey)]);
  }
  private async stopSync() {
    await this.api.alarms.clear(this.alarm);
    await this.api.storage.local.remove(this.key(syncKey));
  }
  // Clear and disable before attempting permission removal; failure must remain closed.
  async disable() {
    await this.save({ status: { state: 'revoked' } });
    await this.saveSettings({ ...(await this.settings()), connected: false, paused: false, mode: 'sites' });
    await this.stopSync();
  }
  // The server's tokens ended (signed out on the server, unused for 30 days, or refused): sync stops, keeping
  // settings and grants, until Reconnect.
  async tokensEnded() {
    await this.api.alarms.clear(this.alarm);
    await this.save({ status: { state: 'empty' } });
  }
  private toReconnect() {
    return this.host.endTokens(this.origin);
  }
  // The organization removed this browser, or turned sync off there: it stops syncing here, keeping its sites and the
  // grants other connections use, until the person syncs here again (connect), which the server takes as lifting it.
  private async removed() {
    const settings = await this.settings();
    await this.save({ status: { state: 'revoked' } });
    await this.saveSettings({ ...settings, connected: false, mode: 'sites' });
    await this.api.alarms.clear(this.alarm);
    await this.saveSync({ state: 'removed' });
    if (settings.mode === 'all') await this.removeAllSites();
    else await this.revokeSites(await this.grantedSites(settings.sites));
  }
  // Leaving this connection behind (Sign out, or the account left the organization): its grants no other connection
  // uses go too.
  async forget(keep?: { sites: string[]; all: boolean }) {
    this.interrupt();
    await this.disable();
    await this.removeAccess(keep).catch(() => undefined);
    await this.api.storage.local.remove(connectionKeys.map(key => this.key(key)));
    await this.api.storage.session.remove(this.key(recordKey));
  }
  // Every grant: the extension needs none to reach its servers, which it calls with OAuth tokens.
  private async optionalGrants() {
    return (await this.api.permissions.getAll()).origins ?? [];
  }
  // Every grant no other connection still uses: theirs stay, and so do `keep`'s.
  private async removeAccess(keep: { sites: string[]; all: boolean } = { sites: [], all: false }) {
    const others = await this.host.others(this.id);
    for (const site of keep.sites) others.sites.add(site);
    if (keep.all) others.all = true;
    const unused = (origins: string[]) =>
      origins.filter(origin =>
        (browserOrigins as readonly string[]).includes(origin)
          ? !others.all
          : !sitesOfOrigins([origin]).some(site => others.sites.has(site)),
      );
    const origins = unused(await this.optionalGrants());
    if (origins.length) await this.api.permissions.remove({ origins });
    if (unused(await this.optionalGrants()).length) throw new Error('permission removal');
  }
  // The all-sites grant, unless another connection captures all sites.
  private async removeAllSites() {
    if (!(await this.host.others(this.id)).all) await this.api.permissions.remove({ origins: [...browserOrigins] });
  }
  private granted(origins: string[]) {
    return this.api.permissions.contains({ origins, permissions: ['cookies'] });
  }
  // The grant a connection needs: all sites, or nothing, since added sites are granted one by one.
  async allowed(settings: Pick<CaptureSettings, 'mode'>) {
    return settings.mode === 'all' ? this.granted([...browserOrigins]) : true;
  }
  private async grantedSites(sites: string[]) {
    const granted = await Promise.all(sites.map(site => this.granted(siteOrigins(site))));
    return sites.filter((_, index) => granted[index]);
  }
  // A site's grant goes only once no other connection uses it.
  private async revokeSites(sites: string[]) {
    const { sites: used } = await this.host.others(this.id);
    const unused = sites.filter(site => !used.has(site));
    if (unused.length) await this.api.permissions.remove({ origins: unused.flatMap(siteOrigins) });
  }
  // Removed sites lose their Chrome grant.
  private async changeSites(settings: CaptureSettings, sites: string[]) {
    const removed = settings.sites.filter(site => !sites.includes(site));
    await this.save({ status: { state: 'empty' } });
    await this.saveSettings({ ...settings, sites });
    if (settings.mode === 'sites' && removed.length) await this.revokeSites(removed);
    return removed.length > 0;
  }
  interrupt() {
    this.epoch++;
    this.upload?.abort();
  }

  // Every request to the server, as the account, in this organization.
  private call(path: string, init: RequestInit) {
    return this.server.call(path, init, this.organization);
  }

  // Captures the user did not ask for. The controller refuses them unless connected and not paused, and uploads only
  // on change. A build the server refused as outdated waits for an update rather than retrying every minute, and a
  // connection waiting for Reconnect captures nothing.
  async automatic(): Promise<Response | undefined> {
    if (!(await this.tokens())) return;
    const { state } = await this.syncRecord();
    const refused = (await this.api.storage.local.get(refusedVersionKey))[refusedVersionKey];
    if (state === 'outdated' && refused === this.host.version) return;
    return (await this.host.handle({ type: 'capture', connection: this.id })) as Response;
  }
  // Chrome reports changes only for granted hosts: added sites, or every site with all-sites access.
  async cookieChanged({ cookie, removed, cause }: CookieChange) {
    // An overwrite reports a removal before the addition; expiry and eviction are not sign-outs.
    if (removed && cause !== 'explicit' && cause !== 'expired_overwrite') return;
    const settings = await this.settings();
    if (!settings.connected || settings.paused || cookieInSites(cookie, this.host.serverSites())) return;
    if (settings.mode === 'sites' && !cookieInSites(cookie, settings.sites)) return;
    if (cookieExcluded(cookie, settings.excludedDomains)) return;
    this.captured ??= new Set((await this.read()).bundle?.cookies.map(cookieKey));
    // A sign-in adds cookies the last capture lacked, and a sign-out deletes ones it had.
    const known = this.captured.has(cookieKey(cookie));
    if (removed ? !known : known) return;
    const { quickQuietMs, quickWaitMs, quickIntervalMs } = await this.config();
    const now = Date.now();
    this.quickStart ??= now;
    const at = Math.max(Math.min(now + quickQuietMs, this.quickStart + quickWaitMs), this.quickAt + quickIntervalMs);
    clearTimeout(this.quickTimer);
    this.quickTimer = setTimeout(() => {
      this.quickTimer = this.quickStart = undefined;
      this.quickAt = Date.now();
      void this.automatic().catch(() => undefined);
    }, at - now);
  }
  // A lost grant, after the capture it may have stopped. A lost site grant is reconciled here, which also covers the
  // grants this extension removes itself.
  async permissionsRemoved(origins: string[], allSites: boolean) {
    const settings = await this.settings();
    if (!(await this.allowed(settings))) {
      await this.save({ status: { state: 'revoked' } });
      // After an explicit disconnect, keep its sync notice (for example delete_failed).
      if (settings.connected) {
        await this.saveSettings({ ...settings, connected: false });
        await this.stopSync();
      }
    } else if (settings.connected && settings.mode === 'sites' && !allSites) {
      // A site revoked in Chrome's settings leaves the account's sites too, like removing it here; the server then
      // deletes its uploaded copy. Unreachable, the server is told at the next fetch. Disconnected, the selection
      // is kept for the next connection, which asks for its grants again. Site grants removed together with the
      // all-sites grant are collateral, not a revocation of those sites: added-sites mode asks for them again.
      const revoked = sitesOfOrigins(origins).filter(site => settings.sites.includes(site));
      if (!revoked.length || (await this.grantedSites(revoked)).length) return;
      await this.api.storage.local.set({
        [this.key(revokedKey)]: [...new Set([...(await this.revokedSites()), ...revoked])],
      });
      const kept = settings.sites.filter(site => !revoked.includes(site));
      await this.changeSites(settings, kept);
      if (await this.tokens()) {
        const server = await this.change(settings, { removeSites: revoked });
        if (server && server !== 'reconnect') await this.reconcile({ ...settings, sites: kept }, server);
      }
    }
  }
  // This connection as the list shows it.
  async summary(entry: ConnectionEntry): Promise<ConnectionSummary> {
    return {
      id: this.id,
      origin: this.origin,
      ...(entry.organization ? { organization: entry.organization } : {}),
      account: await this.accountState(),
      settings: await this.settings(),
    };
  }
  private async accountState(): Promise<AccountState> {
    const stored = await this.server.account();
    return (await this.tokens())
      ? { state: 'syncing', email: stored?.email ?? '' }
      : { state: 'reconnect', ...(stored ? { email: stored.email } : {}) };
  }
  // The connection's status; the controller adds the list of connections.
  async status(): Promise<StatusResponse> {
    let record = await this.read();
    let settings = await this.settings();
    // Any remaining grant, so the popup can offer to remove it while disconnected.
    const permissionGranted = (await this.optionalGrants()).length > 0;
    if (settings.connected && !(await this.allowed(settings))) {
      record = { status: { state: 'revoked' } };
      settings = { ...settings, connected: false };
      await this.save(record);
      await this.saveSettings(settings);
      await this.stopSync();
    }
    const { digest: _digest, connect: _connect, ...sync } = await this.syncRecord();
    const latest = (await this.api.storage.local.get(latestVersionKey))[latestVersionKey];
    // The server offers the manual build, so only a manual build hears of it; Chrome updates store builds.
    const update =
      this.host.distribution === 'manual' &&
      typeof latest === 'string' &&
      compareVersions(latest, this.host.version) > 0
        ? { update: latest }
        : {};
    const granted = settings.mode === 'sites' ? await this.grantedSites(settings.sites) : settings.sites;
    const ungrantedSites = settings.connected ? settings.sites.filter(site => !granted.includes(site)) : [];
    return {
      ok: true,
      connection: this.id,
      origin: this.origin,
      connections: [],
      capture: record.status,
      sync,
      settings,
      account: await this.accountState(),
      permissionGranted,
      ungrantedSites,
      config: await this.config(),
      ...update,
    };
  }
  // Uploads only when the capture differs from the last one the server accepted, and never retries on its own.
  // 'interrupted': pause, disconnect, clear, or exclusions interrupted the upload; success is then not recorded.
  // 'reconnect': the server's tokens ended. 'removed': the organization removed this browser or turned sync off.
  private async sync(bundle: Capture, epoch: number): Promise<'done' | 'interrupted' | 'reconnect' | 'removed'> {
    const previous = await this.syncRecord();
    // The scope counts too, so adding a site with no cookies still tells the server which sites are added.
    const digest = await captureDigest(bundle.cookies, bundle.scope);
    if (previous.digest === digest) {
      await this.saveSync({ ...previous, state: 'unchanged' });
      return 'done';
    }
    // The server never needs the exclusion list, so it stays in this browser.
    const capture: Capture = { ...bundle, scope: { ...bundle.scope, excludedDomains: [] } };
    const body = JSON.stringify({ capture, ...(previous.connect ? { connect: true } : {}) });
    if (new TextEncoder().encode(body).length > (await this.config()).maxUploadBytes) {
      await this.saveSync({ ...previous, state: 'too_large' });
      return 'done';
    }
    await this.saveSync({ ...previous, state: 'uploading' });
    const abort = new AbortController();
    this.upload = abort;
    let next: SyncRecord;
    let ended: 'reconnect' | 'removed' | undefined;
    let received: SyncSettings | undefined;
    try {
      const response = await this.call('/api/v1/captures', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [extensionVersionHeader]: this.host.version },
        body,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(uploadTimeoutMs)]),
      });
      if (response === 'reconnect') {
        ended = 'reconnect';
        next = previous;
      } else {
        const result: unknown = await response.json().catch(() => undefined);
        // The build the server offers, on success and when it refuses this one as outdated.
        const latest = (result as { latestVersion?: unknown } | undefined)?.latestVersion;
        if (typeof latest === 'string' && latest.length <= 32)
          await this.api.storage.local.set({ [latestVersionKey]: latest });
        const accepted = uploadResultSchema.safeParse(result);
        // The account's settings come with every answer that has them, including a refusal while paused.
        received = syncSettingsSchema.safeParse((result as { settings?: unknown } | undefined)?.settings).data;
        if (response.ok && accepted.success) {
          next = {
            state: accepted.data.status === 'stored' ? 'synced' : 'unchanged',
            digest,
            uploadedAt: new Date().toISOString(),
            completedAt: new Date(accepted.data.completedAt).toISOString(),
            cookieCount: accepted.data.cookieCount,
          };
        } else {
          const error = (result as { error?: unknown } | undefined)?.error;
          if (response.status === 409 && error === 'sync_disconnected') ended = 'removed';
          if (response.status === 426) await this.api.storage.local.set({ [refusedVersionKey]: this.host.version });
          // Paused on the account page: the settings below pause this browser too.
          next = {
            ...previous,
            state:
              response.status === 409 && error === 'sync_paused'
                ? previous.state
                : response.status === 503
                  ? 'unavailable'
                  : response.status === 426
                    ? 'outdated'
                    : response.status === 413
                      ? 'too_large'
                      : 'failed',
          };
        }
      }
    } catch {
      // Network, timeout, abort, and refresh errors. Details are not recorded.
      next = { ...previous, state: 'failed' };
    } finally {
      if (this.upload === abort) this.upload = undefined;
    }
    if (epoch !== this.epoch) {
      await this.saveSync(previous);
      return 'interrupted';
    }
    if (ended) {
      await this.saveSync(previous);
      return ended;
    }
    await this.saveSync(next);
    if (received) await this.reconcile(await this.settings(), received);
    return 'done';
  }
  // The account's settings, fetched with the server's config, adopting this browser's settings when the
  // account has none, and bringing this browser in line. Unreachable, the local settings stand until the next fetch.
  private async pull(settings: CaptureSettings): Promise<CaptureSettings> {
    let body: ReturnType<typeof syncResponseSchema.parse>;
    try {
      const response = await this.call('/api/v1/sync', { signal: AbortSignal.timeout(checkTimeoutMs) });
      if (response === 'reconnect') return settings;
      const parsed = syncResponseSchema.safeParse(await response.json().catch(() => undefined));
      if (!response.ok || !parsed.success) return settings;
      body = parsed.data;
    } catch {
      return settings;
    }
    await this.api.storage.local.set({
      [this.key(pulledKey)]: Date.now(),
      ...(body.config === undefined ? {} : { [this.key(configKey)]: body.config }),
      ...(body.latestVersion ? { [latestVersionKey]: body.latestVersion } : {}),
    });
    if (!settings.connected) return settings;
    // A new period from the config takes effect now rather than at the next worker start.
    const { syncPeriodMinutes } = await this.config();
    if (!settings.paused && (await this.api.alarms.get(this.alarm))?.periodInMinutes !== syncPeriodMinutes)
      await this.schedule();
    // The organization removed this browser or turned sync off. A connection waiting for its first upload since the
    // person synced here again lifts that.
    if ((body.disconnected || body.removed) && !(await this.syncRecord()).connect) {
      await this.removed();
      return await this.settings();
    }
    const server = body.settings ?? (await this.adopt(settings));
    return server ? await this.reconcile(settings, server) : settings;
  }
  private pullDue(config: ExtensionConfig, pulledAt: unknown) {
    return typeof pulledAt !== 'number' || Date.now() - pulledAt >= config.settingsRefreshMinutes * 60_000;
  }
  private async adopt(settings: CaptureSettings): Promise<SyncSettings | undefined> {
    const local = { sites: settings.sites, excludedDomains: settings.excludedDomains, paused: settings.paused };
    const adopted = await this.send('POST', '/api/v1/sync/adopt', { settings: local });
    return adopted === 'missing' || adopted === 'reconnect' ? undefined : adopted;
  }
  // A change the account doesn't have settings for yet adopts this browser's first.
  private async change(settings: CaptureSettings, change: SyncChange): Promise<SyncSettings | 'reconnect' | undefined> {
    let changed = await this.send('PATCH', '/api/v1/sync', change);
    if (changed === 'missing' && (await this.adopt(settings)))
      changed = await this.send('PATCH', '/api/v1/sync', change);
    return changed === 'missing' ? undefined : changed;
  }
  // 'missing': the account has no settings yet. 'reconnect': the connection's tokens ended.
  private async send(
    method: string,
    path: string,
    body: unknown,
  ): Promise<SyncSettings | 'missing' | 'reconnect' | undefined> {
    try {
      const response = await this.call(path, {
        method,
        headers: { 'content-type': 'application/json', [extensionVersionHeader]: this.host.version },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(checkTimeoutMs),
      });
      if (response === 'reconnect') return 'reconnect';
      const result = (await response.json().catch(() => undefined)) as { settings?: unknown; error?: unknown };
      if (response.status === 409 && result?.error === 'sync_settings_missing') return 'missing';
      const parsed = syncSettingsSchema.safeParse(result?.settings);
      return response.ok && parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  // Takes the account's sites, exclusions, and pause. Narrowing made here while the server was unreachable (a pause,
  // a site Chrome revoked) is sent first, since the server never widens what this browser captures. Sites the
  // account no longer lists lose their Chrome grant; sites it lists that this browser has not granted are not
  // captured until the user grants them here.
  private async reconcile(settings: CaptureSettings, received: SyncSettings): Promise<CaptureSettings> {
    let server = received;
    const revoked = await this.revokedSites();
    const change: SyncChange = {};
    const stale = revoked.filter(site => server.sites.includes(site));
    if (stale.length) change.removeSites = stale;
    if (settings.paused && !server.paused) change.paused = true;
    const changed = Object.keys(change).length ? await this.send('PATCH', '/api/v1/sync', change) : server;
    if (changed && changed !== 'missing' && changed !== 'reconnect') {
      server = changed;
      if (revoked.length) await this.api.storage.local.remove(this.key(revokedKey));
    } else {
      server = {
        ...server,
        sites: server.sites.filter(site => !stale.includes(site)),
        paused: server.paused || settings.paused,
      };
    }
    const next: CaptureSettings = {
      ...settings,
      sites: server.sites,
      excludedDomains: server.excludedDomains,
      paused: server.paused,
    };
    if (JSON.stringify(next) === JSON.stringify(settings)) return settings;
    const rescoped =
      JSON.stringify([next.sites, next.excludedDomains]) !== JSON.stringify([settings.sites, settings.excludedDomains]);
    if (rescoped || next.paused) await this.save({ status: { state: 'empty' } });
    // Saved before revoking, so the permission event does not count these as revoked in Chrome.
    await this.saveSettings(next);
    if (next.paused && !settings.paused) await this.api.alarms.clear(this.alarm);
    const removed = settings.sites.filter(site => !next.sites.includes(site));
    if (settings.mode === 'sites' && removed.length) await this.revokeSites(await this.grantedSites(removed));
    return next;
  }
  private async revokedSites(): Promise<string[]> {
    const stored = (await this.api.storage.local.get(this.key(revokedKey)))[this.key(revokedKey)];
    return Array.isArray(stored) ? stored.filter((site): site is string => typeof site === 'string') : [];
  }

  // The requests for one connection. `epoch` is this connection's when the request arrived: a capture queued before an
  // interrupting request is discarded.
  async handle(request: CaptureRequest, epoch: number, context: { tab?: number | undefined }): Promise<Response> {
    try {
      if (request.type === 'status') return await this.status();
      const settings = await this.settings();
      if (request.type === 'check') return await this.check(settings);
      if (request.type === 'clear') {
        await this.save({ status: { state: 'empty' } });
        return await this.status();
      }
      if (request.type === 'pause') {
        await this.save({ status: { state: 'empty' } });
        await this.saveSettings({ ...settings, paused: true });
        await this.api.alarms.clear(this.alarm);
        // Paused here at once; the account is told now, or at the next fetch if this fails.
        if (settings.connected && (await this.tokens()))
          await this.change({ ...settings, paused: true }, { paused: true });
        return await this.status();
      }
      if (request.type === 'connect') return await this.connect(settings, request.mode, [], context.tab, epoch);
      if (request.type === 'reconnect') {
        if (!settings.connected || (await this.tokens())) return { ok: false, error: 'invalid_request' };
        await this.host.startFlow(
          { mode: settings.mode, sites: [], reconnect: true, origin: this.origin, connection: this.id },
          context.tab,
        );
        return await this.status();
      }
      if (request.type === 'sites') return await this.select(settings, request.sites, epoch);
      if (request.type === 'narrow') return await this.narrow(settings);
      if (!settings.connected || !(await this.allowed(settings))) return { ok: false, error: 'permission_required' };
      if (request.type === 'resume') {
        // Only a browser resumes the account's sync, so the server must hear it first.
        if (!(await this.tokens())) return { ok: false, error: 'reconnect' };
        const server = await this.change(settings, { paused: false });
        if (server === 'reconnect') return { ok: false, error: 'reconnect' };
        if (!server) return { ok: false, error: 'unavailable' };
        await this.saveSettings({ ...settings, paused: false });
        await this.reconcile({ ...settings, paused: false }, server);
        await this.schedule();
        return await this.status();
      }
      if (request.type !== 'capture') return { ok: false, error: 'invalid_request' };
      // Sync now and the periodic capture fetch the account's settings when they are due.
      let current = settings;
      const due = this.pullDue(
        await this.config(),
        (await this.api.storage.local.get(this.key(pulledKey)))[this.key(pulledKey)],
      );
      if (due && (await this.tokens())) current = await this.pull(current);
      if (!current.connected) return await this.status();
      if (current.paused) return { ok: false, error: 'paused' };
      return await this.capture(current, epoch);
    } catch {
      // Browser and schema error details may contain cookie values.
      await this.save({ status: { state: 'failed' } }).catch(() => undefined);
      return { ok: false, error: 'capture_failed' };
    }
  }
  // A prepared click, once Chrome granted it: connecting, or adding sites.
  async finish(pending: Pending, context: { tab?: number | undefined }, epoch: number): Promise<Response> {
    const settings = await this.settings();
    if (pending.connect)
      return await this.connect(settings, pending.connect, pending.sites, pending.tab ?? context.tab, epoch);
    if (!pending.sites.length) return await this.status();
    return await this.select(
      settings,
      [...settings.sites, ...pending.sites.filter(site => !settings.sites.includes(site))],
      epoch,
    );
  }
  // Agree and connect, once its grants are in place. A connection with live tokens connects here; otherwise this
  // opens the authorize URL in a tab, and the redirect page finishes it (exchange).
  private async connect(
    settings: CaptureSettings,
    mode: CaptureMode,
    sites: string[],
    opener: number | undefined,
    epoch: number,
  ): Promise<Response> {
    if (mode === 'all' && this.host.distribution === 'store') return { ok: false, error: 'invalid_request' };
    if (!(await this.allowed({ mode }))) return { ok: false, error: 'permission_required' };
    if (await this.tokens()) {
      // The tokens may have ended without this browser knowing; a refresh tells.
      const access = await this.server.refresh();
      if (access === 'unavailable') return { ok: false, error: 'unavailable' };
      if (access !== 'reconnect') {
        const next = await this.applyConnect(settings, mode);
        await this.saveSettings(next);
        await this.saveSync({ state: 'never', connect: true });
        await this.schedule();
        await this.host.badge();
        return await this.afterConnect(next, sites, epoch);
      }
    }
    await this.host.startFlow({ mode, sites, reconnect: false, origin: this.origin, connection: this.id }, opener);
    return await this.status();
  }
  // The settings a connection starts with. All sites falls back to added sites if its grant went meanwhile, and
  // added sites keep only the granted ones.
  private async applyConnect(settings: CaptureSettings, mode: CaptureMode): Promise<CaptureSettings> {
    const next: CaptureSettings = { ...settings, mode, connected: true, paused: false };
    if (!(await this.allowed(next))) next.mode = 'sites';
    if (next.mode === 'sites') next.sites = await this.grantedSites(next.sites);
    return next;
  }
  // The server side of connecting: the account's settings, or this browser's when it has none. Agreeing (`resume`)
  // resumes a paused account; Reconnect keeps the pause. Sites added in the connect click are added now; otherwise it
  // syncs now if there is anything to sync.
  async afterConnect(next: CaptureSettings, sites: string[], epoch: number, resume = true): Promise<Response> {
    let current = await this.pull(next);
    if (resume && current.paused && (await this.tokens())) {
      const server = await this.change(current, { paused: false });
      if (server && server !== 'reconnect') {
        await this.saveSettings({ ...current, paused: false });
        current = await this.reconcile({ ...current, paused: false }, server);
      }
      if (!current.paused) await this.schedule();
    }
    if (!(await this.tokens())) return await this.status();
    const added = sites.filter(site => !current.sites.includes(site));
    if (added.length && current.mode === 'sites')
      return await this.select(current, [...current.sites, ...added], epoch);
    if (!current.paused && this.hasScope(current)) return await this.capture(current, epoch);
    return await this.status();
  }
  // The rest of the redirect page's exchange, in the connection it lands in: the one Reconnect came from, else the
  // account's first organization. Reconnect skips the disclosure, so it keeps this connection's mode and pause; a
  // different account's connections are new, so they start in added-sites mode with nothing synced.
  async connected(flow: Flow) {
    const before = await this.settings();
    const next = await this.applyConnect(before, flow.reconnect ? before.mode : flow.mode);
    if (flow.reconnect) next.paused = before.paused;
    const sync: SyncRecord = { state: 'never', connect: true };
    await this.api.storage.local.set({ [this.key(settingsKey)]: next, [this.key(syncKey)]: sync });
    if (!next.paused) await this.schedule();
    this.afterward(flow.sites, !flow.reconnect);
  }
  // Another organization of the account: a new one starts connected with added sites, and takes the
  // organization's settings at its first fetch; one already here resumes as it was.
  async joined() {
    const before = await this.settings();
    if (!before.connected) {
      const sync: SyncRecord = { state: 'never', connect: true };
      await this.api.storage.local.set({
        [this.key(settingsKey)]: { ...before, connected: true, mode: 'sites', paused: false },
        [this.key(syncKey)]: sync,
      });
    }
    const settings = await this.settings();
    if (settings.connected && !settings.paused) await this.schedule();
    this.afterward([], false);
  }
  private afterward(sites: string[], resume: boolean) {
    void this.host.enqueue(async () => {
      try {
        await this.afterConnect(await this.settings(), sites, this.epoch, resume);
      } catch {
        await this.save({ status: { state: 'failed' } }).catch(() => undefined);
      }
    });
  }
  // Use added sites only: records added-sites mode, then removes the all-sites grant, which takes the added sites'
  // grants too. The popup requests those again in the same click; Chrome restores them without a prompt, since it
  // still records them as granted. The connection stays. Another connection that captures all sites keeps the grant.
  private async narrow(settings: CaptureSettings): Promise<Response> {
    if (!settings.connected || settings.mode !== 'all') return { ok: false, error: 'invalid_request' };
    await this.save({ status: { state: 'empty' } });
    await this.saveSettings({ ...settings, mode: 'sites' });
    await this.removeAllSites();
    return await this.status();
  }
  // Opening the popup or the setup tab fetches the account's settings.
  async check(settings: CaptureSettings): Promise<Response> {
    if (settings.connected && (await this.tokens())) await this.pull(settings);
    return await this.status();
  }
  // Added sites capture nothing until the first one is added.
  private hasScope(settings: CaptureSettings) {
    return settings.mode === 'all' || settings.sites.length > 0;
  }
  private async select(settings: CaptureSettings, sites: string[], epoch: number): Promise<Response> {
    if (!settings.connected || !(await this.allowed(settings))) return { ok: false, error: 'permission_required' };
    if (settings.mode !== 'sites') return { ok: false, error: 'invalid_request' };
    if (sites.some(site => this.blocked(site, settings.excludedDomains))) return { ok: false, error: 'excluded' };
    const added = sites.filter(site => !settings.sites.includes(site));
    if (added.length && !(await this.granted(added.flatMap(siteOrigins))))
      return { ok: false, error: 'permission_required' };
    // The account's sites change first; the server deletes a removed site's uploaded copy. Unreachable, or waiting
    // for Reconnect, nothing changes, including the grants this click just gave.
    const removed = settings.sites.filter(site => !sites.includes(site));
    const server = (await this.tokens())
      ? await this.change(settings, {
          ...(added.length ? { addSites: added } : {}),
          ...(removed.length ? { removeSites: removed } : {}),
        })
      : 'reconnect';
    if (!server || server === 'reconnect') {
      await this.revokeSites(added);
      return { ok: false, error: server ?? 'unavailable' };
    }
    const current = await this.reconcile(settings, server);
    // A site the account has since excluded keeps no grant.
    const refused = added.filter(site => !current.sites.includes(site));
    if (refused.length) await this.revokeSites(refused);
    // Adding or removing a site syncs the new selection right away, unless that would hide a failed deletion.
    if (current.paused || (await this.syncRecord()).state === 'delete_failed') return await this.status();
    return await this.capture(current, epoch);
  }
  // Excluded domains, and every connection's server site, are never added.
  private blocked(site: string, excludedDomains: string[]) {
    return this.host.serverSites().includes(site) || excludedDomains.some(domain => within(site, domain));
  }
  // Waiting for Reconnect, nothing is captured.
  private async capture(settings: CaptureSettings, epoch: number): Promise<Response> {
    if (epoch !== this.epoch) return { ok: false, error: 'permission_required' };
    if (!(await this.tokens())) return await this.status();
    const startedAt = new Date().toISOString();
    await this.save({ status: { state: 'capturing' } });
    // Current non-incognito store only. Empty partitionKey includes all partitions.
    // Excluded values never reach storage, messages, UI, logs, or the server. Chrome returns only granted sites; no
    // connection's server session is ever synced.
    // The account may list sites this browser has not granted; those are not captured until the user grants them.
    const sites = settings.mode === 'sites' ? await this.grantedSites(settings.sites) : [];
    const serverSites = this.host.serverSites();
    const allCookies = await this.api.cookies.getAll({ partitionKey: {} });
    const cookies = allCookies.filter(
      cookie =>
        !cookieExcluded(cookie, settings.excludedDomains) &&
        !cookieInSites(cookie, serverSites) &&
        (settings.mode === 'all' || cookieInSites(cookie, sites)),
    );
    const bundle = captureSchema.parse({
      schemaVersion: 2,
      id: crypto.randomUUID(),
      scope:
        settings.mode === 'all'
          ? { mode: 'whole-browser', excludedDomains: settings.excludedDomains }
          : { mode: 'sites', sites, excludedDomains: settings.excludedDomains },
      startedAt,
      completedAt: new Date().toISOString(),
      consistency: 'non-atomic-cookie-read',
      coverage: 'cookies-only',
      storeId: allCookies[0]?.storeId ?? '0',
      cookies,
    });
    if (epoch !== this.epoch || !(await this.allowed(settings))) {
      await this.save({ status: { state: 'interrupted' } });
      return { ok: false, error: 'permission_required' };
    }
    await this.save({
      status: { state: 'complete', completedAt: bundle.completedAt, cookieCount: cookies.length },
      bundle,
    });
    const synced =
      epoch === this.epoch && (await this.allowed(settings)) ? await this.sync(bundle, epoch) : 'interrupted';
    if (synced === 'interrupted') {
      await this.save({ status: { state: 'interrupted' } });
      return { ok: false, error: 'permission_required' };
    }
    if (synced === 'reconnect') await this.toReconnect();
    if (synced === 'removed') await this.removed();
    return await this.status();
  }
}

export class CaptureController {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly ready: Promise<void>;
  // The stored list, read at startup and kept in step with storage; and each connection's live state.
  private entries: ConnectionEntry[] = [];
  private readonly live = new Map<string, Connection>();
  private readonly servers = new Map<string, Server>();
  private selectedId: string | undefined;
  private readonly host: Host;
  constructor(
    private readonly api: CaptureBrowser,
    // The build's server: where existing installs and new connections connect unless the person names another, and
    // where the verified list comes from.
    private readonly serverOrigin: string,
    private readonly version: string,
    private readonly distribution: Distribution,
    // chrome-extension://<id>/connected.html, the OAuth redirect URI.
    private readonly redirectUri: string,
  ) {
    this.host = {
      api,
      version,
      distribution,
      redirectUri,
      enqueue: work => this.enqueue(work),
      handle: request => this.handle(request),
      others: connection => this.others(connection),
      serverSites: () => [
        ...new Set(
          [this.serverOrigin, ...this.entries.map(entry => entry.origin)].map(o => siteOfHost(new URL(o).hostname)),
        ),
      ],
      badge: () => this.badge(),
      startFlow: (flow, from) => this.startFlow(flow, from),
      server: origin => this.server(origin),
      endTokens: origin => this.endTokens(origin),
      organizationsChanged: origin => {
        void this.enqueue(() => this.refreshOrganizations(origin)).catch(() => undefined);
      },
      signOut: origin => this.signOut(origin),
    };
    this.ready = this.initialize();
  }

  private async initialize() {
    await Promise.all([
      this.api.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
      this.api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    ]);
    await this.migrate();
    for (const connection of this.connections()) await connection.initialize();
    await this.badge();
  }
  // An install from before accounts starts fresh: its connections and their keys go, keeping Chrome's grants, so the
  // person signs in once and each organization's sites come back from the server.
  private async migrate() {
    const local = await this.api.storage.local.get(null);
    const stored = local[connectionsKey];
    if (local[layoutKey] === layout) {
      this.entries = Array.isArray(stored) ? stored.filter(isEntry) : [];
      const selected = local[selectedKey];
      if (typeof selected === 'string') this.selectedId = selected;
      return;
    }
    const entries = Array.isArray(stored) ? stored.filter(isEntry) : [];
    const kept = new Set([latestVersionKey, refusedVersionKey]);
    await this.api.storage.local.remove(Object.keys(local).filter(key => !kept.has(key)));
    await this.api.storage.session.remove([recordKey, ...entries.map(entry => keyOf(recordKey, entry.id))]);
    for (const entry of entries) await this.api.alarms.clear(alarmOf(entry.id));
    await this.api.alarms.clear(syncAlarm);
    await this.api.storage.local.set({ [layoutKey]: layout });
  }
  private connection(entry: ConnectionEntry): Connection {
    let connection = this.live.get(entry.id);
    if (!connection) {
      connection = new Connection(this.host, entry.id, entry.origin, entry.legacy ? undefined : entry.organization?.id);
      this.live.set(entry.id, connection);
    }
    return connection;
  }
  private connections(origin?: string) {
    return this.entries.filter(entry => origin === undefined || entry.origin === origin).map(e => this.connection(e));
  }
  private server(origin: string): Server {
    let server = this.servers.get(origin);
    if (!server) {
      server = new Server(this.host, origin);
      this.servers.set(origin, server);
    }
    return server;
  }
  // The connection a request names, which the popup shows from then on; without one, the one it showed last, else the
  // first.
  private find(id: string | undefined) {
    if (id !== undefined) {
      const entry = this.entries.find(each => each.id === id);
      if (entry) this.select(entry.id);
      return entry && this.connection(entry);
    }
    const entry = this.entries.find(each => each.id === this.selectedId) ?? this.entries[0];
    return entry && this.connection(entry);
  }
  private select(id: string) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    void this.api.storage.local.set({ [selectedKey]: id }).catch(() => undefined);
  }
  private async saveEntries(entries: ConnectionEntry[]) {
    await this.api.storage.local.set({ [connectionsKey]: entries });
    this.entries = entries;
  }
  private async others(id: string) {
    const sites = new Set<string>();
    let all = false;
    for (const connection of this.connections()) {
      if (connection.id === id) continue;
      const settings = await connection.settings();
      if (!settings.connected) continue;
      if (settings.mode === 'all') all = true;
      else for (const site of settings.sites) sites.add(site);
    }
    return { sites, all };
  }
  // A server waiting for Reconnect marks the toolbar icon.
  private async badge() {
    let reconnect = false;
    for (const origin of new Set(this.entries.map(entry => entry.origin)))
      if (!(await this.server(origin).tokens())) reconnect = true;
    await this.api.action.setBadgeText({ text: reconnect ? '!' : '' }).catch(() => undefined);
  }
  private async endTokens(origin: string) {
    await this.api.storage.local.remove(keyOf(tokensKey, origin));
    for (const connection of this.connections(origin)) await connection.tokensEnded();
    await this.badge();
  }
  // Brings a server's connections in line with the account's organizations: one for each, named as the server names
  // it now, and none for an organization the account has left. `keep` is what a sign-in in progress was granted for.
  private async syncOrganizations(
    origin: string,
    me: Pick<Me, 'organizations' | 'legacy'>,
    keep?: { sites: string[]; all: boolean },
  ) {
    const added: Connection[] = [];
    const entries = this.entries.filter(entry => entry.origin !== origin);
    const ours = this.entries.filter(entry => entry.origin === origin);
    for (const organization of me.legacy && !me.organizations.length ? [undefined] : me.organizations) {
      const found = ours.find(entry => entry.organization?.id === organization?.id && !!entry.legacy === me.legacy);
      const entry: ConnectionEntry = {
        id: found?.id ?? crypto.randomUUID(),
        origin,
        ...(organization ? { organization } : {}),
        ...(me.legacy ? { legacy: true as const } : {}),
      };
      entries.push(entry);
      if (!found) added.push(this.connection(entry));
    }
    const gone = ours.filter(entry => !entries.some(each => each.id === entry.id)).map(e => this.connection(e));
    // Unlisted first, so their grants count as unused.
    await this.saveEntries(entries);
    for (const connection of gone) {
      await connection.forget(keep);
      this.live.delete(connection.id);
    }
    return added;
  }
  // Fetches a server's organizations again, after a request named one the account has left.
  private async refreshOrganizations(origin: string) {
    const me = await this.server(origin).me();
    if (me && me !== 'reconnect') for (const added of await this.syncOrganizations(origin, me)) await added.joined();
  }
  // Sign out: deletes what this browser uploaded to every organization on the server, with the bearer token, which
  // also signs the browser out there; never /oauth2/revoke, which the server refuses for the extension. Every
  // connection on the server goes, with the grants no other server's connections use, whatever the server says.
  private async signOut(origin: string) {
    const server = this.server(origin);
    for (const connection of this.connections(origin)) connection.interrupt();
    let deleted = false;
    try {
      if (await server.tokens()) {
        const response = await server.call('/api/v1/captures', {
          method: 'DELETE',
          signal: AbortSignal.timeout(deleteTimeoutMs),
        });
        deleted = response !== 'reconnect' && response.ok;
      } else deleted = true;
    } catch {
      // Not confirmed, so reported below.
    } finally {
      await this.api.storage.local.remove([keyOf(tokensKey, origin), keyOf(accountKey, origin)]);
      const gone = this.connections(origin);
      // Unlisted first, so their grants count as unused.
      await this.saveEntries(this.entries.filter(entry => entry.origin !== origin));
      for (const connection of gone) {
        await connection.forget();
        this.live.delete(connection.id);
      }
      if (!deleted) await this.api.storage.local.set({ [signOutFailedKey]: origin });
      else await this.api.storage.local.remove(signOutFailedKey);
      await this.badge();
    }
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => this.ready).then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  // Periodic capture: one connection's alarm, or every connection's on Chrome startup. Answers with the named
  // connection's result, or the first connection's.
  async alarmFired(name: string): Promise<Response | undefined> {
    await this.ready;
    if (name === syncAlarm) {
      const results = await Promise.all(this.connections().map(connection => connection.automatic()));
      return results[0];
    }
    return this.connections()
      .find(connection => connection.alarm === name)
      ?.automatic();
  }
  // Each connection decides whether the change is in its scope and starts its own quick capture.
  async cookieChanged(change: CookieChange) {
    await this.ready;
    await Promise.all(this.connections().map(connection => connection.cookieChanged(change)));
  }
  // A grant can finish a click whose popup Chrome's prompt closed.
  async permissionsAdded(): Promise<Response> {
    return (await this.handle({ type: 'finish' })) as Response;
  }
  private async pending(): Promise<Pending | undefined> {
    const pending = (await this.api.storage.session.get(pendingKey))[pendingKey] as Pending | undefined;
    if (pending && Date.now() - pending.at <= pendingTtlMs) return pending;
    if (pending) await this.api.storage.session.remove(pendingKey);
    return undefined;
  }
  // The connect flow, while it is fresh; an expired one is removed.
  private async flow(): Promise<Flow | undefined> {
    const flow = (await this.api.storage.session.get(flowKey))[flowKey] as Flow | undefined;
    if (flow && Date.now() - flow.at <= flowTtlMs) return flow;
    if (flow) await this.api.storage.session.remove(flowKey);
    return undefined;
  }
  // Losing the all-sites grant stops a capture in flight in the connections that rely on it. A lost site grant is
  // reconciled after it instead, in every connection that has the site.
  permissionsRemoved(origins: string[] = []): Promise<void> {
    const allSites = origins.some(origin => (browserOrigins as readonly string[]).includes(origin));
    if (!origins.length) for (const connection of this.connections()) connection.interrupt();
    // Use added sites only removes it after saving added-sites mode, which must not interrupt its own capture.
    else if (allSites)
      for (const connection of this.connections())
        void connection.settings().then(settings => {
          if (settings.mode === 'all') connection.interrupt();
        });
    return this.enqueue(async () => {
      for (const connection of this.connections()) await connection.permissionsRemoved(origins, allSites);
    });
  }
  // The status of a connection, or of a new one without any, with the list of every connection.
  private async withList(response: Response): Promise<Response> {
    if (!response.ok) return response;
    const connections = await Promise.all(this.entries.map(entry => this.connection(entry).summary(entry)));
    // A connect flow is waiting for the server's tab.
    const connecting = (await this.flow()) ? { connecting: true as const } : {};
    const failed = (await this.api.storage.local.get(signOutFailedKey))[signOutFailedKey];
    return {
      ...response,
      connections,
      ...connecting,
      ...(typeof failed === 'string' ? { signOutFailed: failed } : {}),
    };
  }
  private async blank(): Promise<StatusResponse> {
    const latest = (await this.api.storage.local.get(latestVersionKey))[latestVersionKey];
    return {
      ok: true,
      origin: this.serverOrigin,
      connections: [],
      capture: { state: 'empty' },
      sync: { state: 'never' },
      settings: defaultSettings(),
      account: { state: 'none' },
      permissionGranted: ((await this.api.permissions.getAll()).origins ?? []).length > 0,
      ungrantedSites: [],
      config: parseExtensionConfig(undefined),
      ...(this.distribution === 'manual' && typeof latest === 'string' && compareVersions(latest, this.version) > 0
        ? { update: latest }
        : {}),
    };
  }

  // `context.tab` is the sender's tab, which a connect tab returns to. A request acts on the connection it names, or
  // the one the popup showed last; `another` signs in to a server (the build's, or the one it names).
  async handle(
    input: unknown,
    context: { tab?: number | undefined } = {},
  ): Promise<Response | ExchangeResponse | ServerResponse> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };
    const request = parsed.data;
    // Outside the queue: it changes nothing, and the verified list may take a while to arrive.
    if (request.type === 'server') {
      await this.ready;
      const origin = serverOriginOfInput(request.origin);
      return origin ? await this.trust(await this.canonical(origin)) : { ok: false, error: 'invalid_request' };
    }
    const named = 'connection' in request ? request.connection : undefined;
    const another = 'another' in request && request.another === true;
    const target = another ? undefined : this.find(named);
    if (['disconnect', 'clear', 'pause', 'sites', 'narrow'].includes(request.type)) target?.interrupt();
    if (request.type === 'exchange') for (const connection of this.connections()) connection.interrupt();
    // Snapshot at arrival: a capture queued before an interrupting request is discarded.
    const epoch = target?.epoch;
    return this.enqueue(async (): Promise<Response | ExchangeResponse> => {
      try {
        if (request.type === 'update') return await this.withList(await this.update());
        if (request.type === 'exchange') return await this.exchange(request.url);
        if (request.type === 'prepare') {
          if (request.connect === 'all' && this.distribution === 'store')
            return { ok: false, error: 'invalid_request' };
          if (named !== undefined && !this.find(named)) return { ok: false, error: 'invalid_request' };
          // Refused before Chrome's prompt, not after it.
          const server = another ? await this.serverFor(request) : undefined;
          if (server && 'error' in server) return server;
          const pending: Pending = {
            sites: request.sites,
            at: Date.now(),
            ...(request.connect ? { connect: request.connect } : {}),
            ...(context.tab === undefined ? {} : { tab: context.tab }),
            ...(another ? { another: true as const } : named === undefined ? {} : { connection: named }),
            ...(server?.origin === undefined ? {} : { origin: server.origin }),
            ...(another && request.warned ? { warned: true as const } : {}),
          };
          await this.api.storage.session.set({ [pendingKey]: pending });
          return await this.status(another ? undefined : this.find(named));
        }
        if (request.type === 'finish') return await this.finish(context);
        // Signing in to a server, before any connection or beside them.
        const connection = another ? undefined : this.find(named);
        if (named !== undefined && !another && !connection) return { ok: false, error: 'invalid_request' };
        if (!connection) {
          if (request.type === 'connect')
            return await this.connectAnother(request.mode, [], context.tab, another ? request : {});
          if (request.type === 'status' || request.type === 'check' || request.type === 'clear')
            return await this.status(undefined);
          // Remove browser access, before any connection.
          if (request.type === 'disconnect') {
            const origins = (await this.api.permissions.getAll()).origins ?? [];
            if (origins.length) await this.api.permissions.remove({ origins });
            return await this.status(undefined);
          }
          return { ok: false, error: 'permission_required' };
        }
        // Sign out of the connection's server, which every connection on it shares.
        if (request.type === 'disconnect') {
          await this.signOut(connection.origin);
          return await this.status(this.find(undefined));
        }
        // Opening the popup or the setup tab fetches each server's organizations and every connection's settings.
        if (request.type === 'check') {
          for (const origin of new Set(this.entries.map(entry => entry.origin)))
            if (await this.server(origin).tokens()) await this.refreshOrganizations(origin);
          for (const each of this.connections()) if (each !== connection) await each.check(await each.settings());
          const current = this.find(undefined);
          if (current && current !== connection) return await this.status(current);
          if (!current) return await this.status(undefined);
        }
        return await this.withList(
          await connection.handle(
            request,
            epoch === undefined || target !== connection ? connection.epoch : epoch,
            context,
          ),
        );
      } catch {
        return { ok: false, error: 'capture_failed' };
      }
    }).catch((): Response => ({ ok: false, error: 'capture_failed' }));
  }
  private async status(connection: Connection | undefined) {
    return this.withList(connection ? await connection.status() : await this.blank());
  }
  private async finish(context: { tab?: number | undefined }): Promise<Response> {
    const pending = await this.pending();
    const connection = pending?.another ? undefined : this.find(pending?.connection);
    if (!pending) return await this.status(connection);
    const needed = [...(pending.connect === 'all' ? browserOrigins : []), ...pending.sites.flatMap(siteOrigins)];
    // Not granted yet: keep it for the permission event, until it expires.
    if (!(await this.api.permissions.contains({ origins: needed, permissions: ['cookies'] })))
      return await this.status(connection);
    await this.api.storage.session.remove(pendingKey);
    if (!connection) {
      if (pending.connect)
        return await this.connectAnother(pending.connect, pending.sites, pending.tab ?? context.tab, pending);
      return await this.status(undefined);
    }
    return await this.withList(await connection.finish(pending, context, connection.epoch));
  }
  // Signing in to a server: the build's, or `origin`.
  private async connectAnother(
    mode: CaptureMode,
    sites: string[],
    opener: number | undefined,
    choice: { origin?: string | undefined; warned?: true | undefined },
  ): Promise<Response> {
    if (mode === 'all' && this.distribution === 'store') return { ok: false, error: 'invalid_request' };
    const server = await this.serverFor(choice);
    if ('error' in server) return server;
    if (
      mode === 'all' &&
      !(await this.api.permissions.contains({ origins: [...browserOrigins], permissions: ['cookies'] }))
    )
      return { ok: false, error: 'permission_required' };
    await this.startFlow({ mode, sites, reconnect: false, origin: server.origin ?? this.serverOrigin }, opener);
    return await this.status(undefined);
  }
  // The server a connect click names, once it may be connected to: a server that needs the warning needs `warned`.
  private async serverFor(choice: {
    origin?: string | undefined;
    warned?: true | undefined;
  }): Promise<{ origin?: string } | { ok: false; error: 'invalid_request' | 'unverified_server' }> {
    if (choice.origin === undefined) return {};
    const typed = serverOriginOfInput(choice.origin);
    if (!typed) return { ok: false, error: 'invalid_request' };
    const origin = await this.canonical(typed);
    if (!choice.warned && (await this.trust(origin)).trust === 'unverified')
      return { ok: false, error: 'unverified_server' };
    return { origin };
  }
  // The address a server signs people in at, as its proof file names it after any redirect, so an alias of it (such as
  // the bare domain of a www site) signs in where the server's issuer is rather than failing the `iss` check. Without
  // an answer, the address as given.
  private async canonical(origin: string): Promise<string> {
    if (origin === this.serverOrigin || this.entries.some(entry => entry.origin === origin)) return origin;
    try {
      const response = await this.api.fetch(`${origin}${serverProofPath}`, {
        credentials: 'omit',
        signal: AbortSignal.timeout(checkTimeoutMs),
      });
      const proof = serverProofSchema.safeParse(await response.json());
      const named = response.ok && proof.success ? serverOriginOfInput(proof.data.origin) : undefined;
      return named ?? origin;
    } catch {
      return origin;
    }
  }
  // Whether connecting to a server needs the warning. The administrator's approval needs no request; the verified list
  // is asked of the build's server, without anything about the person, and falls back to the built-in copy.
  private async trust(origin: string): Promise<ServerResponse> {
    if (origin === this.serverOrigin) return { ok: true, origin, trust: 'build' };
    if (this.entries.some(entry => entry.origin === origin)) return { ok: true, origin, trust: 'connected' };
    const approved = (
      await this.api.storage.managed.get(approvedServersKey).catch(() => ({}) as { [key: string]: unknown })
    )[approvedServersKey];
    if (
      Array.isArray(approved) &&
      approved.some(each => typeof each === 'string' && serverOriginOfInput(each) === origin)
    )
      return { ok: true, origin, trust: 'policy' };
    const verified = (await this.verifiedServers()).find(each => each.origin === origin);
    return verified
      ? { ok: true, origin, trust: 'verified', name: verified.name }
      : { ok: true, origin, trust: 'unverified' };
  }
  private async verifiedServers(): Promise<VerifiedServer[]> {
    try {
      const response = await this.api.fetch(`${this.serverOrigin}${verifiedServersPath}`, {
        credentials: 'omit',
        signal: AbortSignal.timeout(checkTimeoutMs),
      });
      const parsed = verifiedServersSchema.safeParse(await response.json());
      if (response.ok && parsed.success) return parsed.data.servers;
    } catch {
      // The built-in copy below.
    }
    return builtInVerifiedServers;
  }
  // Update now, in store builds only: asks Chrome for the store's update and reloads into it when Chrome has one, which
  // ends this worker. Otherwise Chrome installs it later on its own (`noUpdate`).
  private async update(): Promise<Response> {
    if (this.distribution !== 'store') return { ok: false, error: 'invalid_request' };
    const { status } = await this.api.runtime.requestUpdateCheck();
    if (status === 'update_available') this.api.runtime.reload();
    const current = this.find(undefined);
    return {
      ...(current ? await current.status() : await this.blank()),
      ...(status === 'update_available' ? {} : { noUpdate: true as const }),
    };
  }
  // Opens the server's authorize URL in a tab next to the one the click came from, which signs the user in if
  // needed. A new flow replaces an earlier one.
  private async startFlow(
    flow: Pick<Flow, 'mode' | 'sites' | 'reconnect' | 'origin' | 'connection'>,
    from: number | undefined,
  ) {
    const opener = from ?? (await this.api.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
    const { verifier, challenge } = await pkce();
    const state = newState();
    const stored: Flow = { ...flow, state, verifier, at: Date.now(), ...(opener === undefined ? {} : { opener }) };
    await this.api.storage.session.set({ [flowKey]: stored });
    const url = authorizeUrl(flow.origin ?? this.serverOrigin, this.redirectUri, { state, challenge });
    try {
      if (opener === undefined) throw new Error('no opener');
      const tab = await this.api.tabs.get(opener);
      await this.api.tabs.create({
        url,
        active: true,
        windowId: tab.windowId,
        openerTabId: opener,
        index: tab.index + 1,
      });
    } catch {
      await this.api.tabs.create({ url, active: true });
    }
  }
  // The redirect page's code. Only the state of a flow this extension started, from that flow's server (`iss`), and
  // each verifier once: the server revokes the tokens a replayed code issued. Nothing is written until /me names the
  // account, so an unknown account never is. A different account than the one signed in there before starts fresh:
  // that account's connections go. The account's organizations become the server's connections, and the flow lands
  // in the one its click came from (Reconnect, or syncing there again), else the account's first, which the popup
  // shows from then on.
  private async exchange(url: string): Promise<Response | ExchangeResponse> {
    const redirect = readRedirect(url, this.redirectUri);
    if (!redirect) return { ok: false, error: 'invalid_request' };
    const flow = await this.flow();
    // A redirect that isn't this flow's leaves the flow usable.
    if (!flow || redirect.state !== flow.state) return { ok: false, error: 'expired' };
    await this.api.storage.session.remove(flowKey);
    const origin = flow.origin ?? this.serverOrigin;
    if (redirect.iss !== issuerOf(origin)) return { ok: false, error: 'invalid_request' };
    if ('error' in redirect) return { ok: false, error: 'denied' };
    const result = await requestTokens(
      this.api.fetch,
      origin,
      { code: redirect.code, verifier: flow.verifier, redirectUri: this.redirectUri },
      AbortSignal.timeout(checkTimeoutMs),
    );
    if (typeof result !== 'object') return { ok: false, error: 'unavailable' };
    const { tokens } = result;
    const me = await meAt(this.api.fetch, origin, tokens.access);
    // A server from before accounts may name no organization; one that lists them lists at least one, since it
    // refuses to connect someone in none.
    if (!me || (!me.legacy && !me.organizations.length)) {
      // Best effort: the server knows the browser from its code exchange, so this signs it out. If this fails too, the
      // server forgets it once unused for 30 days.
      await this.api
        .fetch(`${origin}/api/v1/captures`, {
          method: 'DELETE',
          credentials: 'omit',
          headers: { authorization: `Bearer ${tokens.access}` },
          signal: AbortSignal.timeout(deleteTimeoutMs),
        })
        .catch(() => undefined);
      return { ok: false, error: 'unavailable' };
    }
    const server = this.server(origin);
    const previous = await server.account();
    // What this flow's click was granted, which a different account's connections leave in place. Reconnect is
    // granted nothing.
    const keep = { sites: flow.sites, all: !flow.reconnect && flow.mode === 'all' };
    if (previous?.id !== me.account.id) {
      const gone = this.connections(origin);
      await this.saveEntries(this.entries.filter(entry => entry.origin !== origin));
      for (const connection of gone) {
        await connection.forget(keep);
        this.live.delete(connection.id);
      }
    }
    await this.api.storage.local.set({ [keyOf(tokensKey, origin)]: tokens, [keyOf(accountKey, origin)]: me.account });
    await this.api.storage.local.remove(signOutFailedKey);
    await this.syncOrganizations(origin, me, keep);
    const ours = this.entries.filter(entry => entry.origin === origin);
    const landing =
      ours.find(entry => entry.id === flow.connection) ||
      ours.find(entry => entry.organization?.id === me.first) ||
      ours[0]!;
    this.select(landing.id);
    for (const connection of this.connections(origin))
      if (connection.id === landing.id) await connection.connected(flow);
      else await connection.joined();
    await this.badge();
    return {
      ok: true,
      email: me.account.email,
      ...(landing.organization ? { organization: landing.organization.name } : {}),
      ...(flow.opener === undefined ? {} : { opener: flow.opener }),
    };
  }
}

// The popup and the setup tab send any request but `exchange`; the redirect page, top-level in its own tab, sends
// only `exchange`. Its address carries the code, so only its path is compared.
export function trustedSender(
  sender: Pick<chrome.runtime.MessageSender, 'id' | 'url' | 'frameId' | 'tab'>,
  extensionId: string,
  message: unknown,
): boolean {
  if (sender.id !== extensionId || !sender.url) return false;
  const base = `chrome-extension://${extensionId}/`;
  const exchange = (message as { type?: unknown } | null)?.type === 'exchange';
  // `setup.html#server` is the setup tab opened at Connect to another server.
  if (['popup.html', 'setup.html', 'setup.html#server'].some(page => sender.url === `${base}${page}`)) return !exchange;
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return false;
  }
  return (
    `${url.protocol}//${url.host}${url.pathname}` === `${base}connected.html` &&
    sender.frameId === 0 &&
    sender.tab !== undefined &&
    exchange
  );
}
