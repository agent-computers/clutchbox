import {
  type AccountState,
  authorizeUrl,
  browserOrigins,
  type Capture,
  type CaptureMode,
  type CaptureSettings,
  type CaptureStatus,
  captureDigest,
  captureSchema,
  compareVersions,
  cookieExcluded,
  cookieInSites,
  type ExchangeResponse,
  type ExtensionConfig,
  extensionVersionHeader,
  flowTtlMs,
  issuerOf,
  meSchema,
  newState,
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
  type StatusResponse,
  type SyncChange,
  type SyncRecord,
  type SyncSettings,
  type SyncTokens,
  siteOfHost,
  siteOrigins,
  sitesOfOrigins,
  syncRecordSchema,
  syncResponseSchema,
  syncSettingsSchema,
  type TokenResult,
  timeoutSignal,
  uploadResultSchema,
  within,
} from '@agent-computers/capture';

export const recordKey = 'captureRecord';
export const settingsKey = 'captureSettings';
export const syncKey = 'syncState';
export const latestVersionKey = 'latestVersion';
// The build the server last refused as outdated; the periodic capture waits until this build changes.
export const refusedVersionKey = 'refusedVersion';
// The server's config, when the extension last fetched its settings, and sites Chrome revoked that the
// server has not yet been told about (local storage).
export const configKey = 'extensionConfig';
export const pulledKey = 'settingsPulledAt';
export const revokedKey = 'revokedSites';
export const pendingKey = 'pendingGrant';
// The connection's OAuth tokens and the account they belong to (local storage). The account is kept across
// Disconnect and Reconnect, so connecting as a different account can start fresh.
export const tokensKey = 'syncTokens';
export const accountKey = 'syncAccount';
// A connect flow waiting for the Agent Computers tab: its state and PKCE verifier (session storage).
export const flowKey = 'oauthFlow';
// Chrome's prompt closes the popup on some platforms, so the click's purpose waits here for the grant. `tab` is the
// page it came from, which the connect tab returns to.
export const pendingTtlMs = 120_000;
type Pending = { connect?: CaptureMode; sites: string[]; at: number; tab?: number };
// `sites` are added once connected; `reconnect` resumes a connection whose tokens ended.
type Flow = {
  state: string;
  verifier: string;
  at: number;
  mode: CaptureMode;
  sites: string[];
  reconnect: boolean;
  opener?: number;
};
// The periodic capture, which uploads only on change. Its period, the quick capture's timings after sign-ins and
// sign-outs, and the upload cap come from the server's config (ExtensionConfig), within fixed bounds.
export const syncAlarm = 'capture-sync';
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
type Access = string | 'reconnect' | 'unavailable';
type StorageArea = Pick<typeof chrome.storage.session, 'get' | 'set' | 'remove' | 'setAccessLevel'>;
// Chrome Web Store builds update through Chrome and offer added sites only; manual (unpacked) builds update by hand from
// the server's account page and also offer all sites.
export type Distribution = 'store' | 'manual';
export interface CaptureBrowser {
  permissions: Pick<typeof chrome.permissions, 'contains' | 'remove' | 'getAll'>;
  cookies: Pick<typeof chrome.cookies, 'getAll'>;
  storage: { session: StorageArea; local: StorageArea };
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

export class CaptureController {
  private epoch = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private upload: AbortController | undefined;
  private refreshing: Promise<Access> | undefined;
  // The last capture's cookie keys, read from session storage when first needed after it changes.
  private captured: Set<string> | undefined;
  private quickTimer: ReturnType<typeof setTimeout> | undefined;
  private quickStart: number | undefined;
  private quickAt = 0;
  private readonly ready: Promise<void>;
  constructor(
    private readonly api: CaptureBrowser,
    private readonly serverOrigin: string,
    private readonly version: string,
    private readonly distribution: Distribution,
    // chrome-extension://<id>/connected.html, the OAuth redirect URI.
    private readonly redirectUri: string,
  ) {
    this.ready = this.initialize();
  }

  private async initialize() {
    await Promise.all([
      this.api.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
      this.api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    ]);
    const record = await this.read();
    const settings = await this.settings();
    if (!settings.connected || settings.paused || (record.bundle && !captureSchema.safeParse(record.bundle).success)) {
      await this.save({ status: { state: 'empty' } });
    } else if (record.status.state === 'capturing') {
      await this.save({ status: { state: 'interrupted' } });
    }
    const sync = await this.syncRecord();
    if (sync.state === 'uploading') await this.saveSync({ ...sync, state: 'failed' });
    // Connected without tokens: an install updated from a build that synced with the web sign-in, or a connection
    // whose tokens ended. It waits for Reconnect.
    const reconnect = settings.connected && !(await this.tokens());
    if (reconnect) await this.badge('!');
    if (!settings.connected || settings.paused || reconnect) await this.api.alarms.clear(syncAlarm);
    // Recreating an existing alarm would restart its period on every worker wake. One from an older build's period
    // is replaced.
    else if ((await this.api.alarms.get(syncAlarm))?.periodInMinutes !== (await this.config()).syncPeriodMinutes)
      await this.schedule();
  }
  private async read(): Promise<Record> {
    const data = await this.api.storage.session.get(recordKey);
    return (data[recordKey] as Record | undefined) ?? { status: { state: 'empty' } };
  }
  private async settings(): Promise<CaptureSettings> {
    const data = await this.api.storage.local.get(settingsKey);
    return parseSettings(data[settingsKey]);
  }
  private async syncRecord(): Promise<SyncRecord> {
    const data = await this.api.storage.local.get(syncKey);
    // Records from removed states: the invite gate and the web sign-in become failed, keeping the reconnect flag but
    // not the digest; a dashboard disconnect, which now ends the tokens, starts over.
    const stored = data[syncKey] as { state?: unknown; connect?: unknown } | undefined;
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
    return this.api.storage.session.set({ [recordKey]: record });
  }
  private saveSettings(settings: CaptureSettings) {
    return this.api.storage.local.set({ [settingsKey]: settings });
  }
  private saveSync(record: SyncRecord) {
    return this.api.storage.local.set({ [syncKey]: record });
  }
  private async account(): Promise<Account | undefined> {
    return (await this.api.storage.local.get(accountKey))[accountKey] as Account | undefined;
  }
  private async tokens(): Promise<SyncTokens | undefined> {
    const stored = (await this.api.storage.local.get(tokensKey))[tokensKey];
    return isTokens(stored) ? stored : undefined;
  }
  private async badge(text: string) {
    await this.api.action.setBadgeText({ text }).catch(() => undefined);
  }
  private async schedule() {
    await this.api.alarms.create(syncAlarm, { periodInMinutes: (await this.config()).syncPeriodMinutes });
  }
  private async config(): Promise<ExtensionConfig> {
    return parseExtensionConfig((await this.api.storage.local.get(configKey))[configKey]);
  }
  private async stopSync() {
    await this.api.alarms.clear(syncAlarm);
    await this.api.storage.local.remove(syncKey);
  }
  // Clear and disable before attempting permission removal; failure must remain closed.
  // Added sites and exclusions are kept for the next connection, which defaults to added sites.
  private async disable() {
    await this.save({ status: { state: 'revoked' } });
    await this.saveSettings({ ...(await this.settings()), connected: false, paused: false, mode: 'sites' });
    await this.stopSync();
  }
  // The connection's tokens ended (disconnected, unused for 30 days, or refused): sync stops, keeping settings,
  // grants and the account, until Reconnect.
  private async toReconnect() {
    await this.api.storage.local.remove(tokensKey);
    await this.api.alarms.clear(syncAlarm);
    await this.save({ status: { state: 'empty' } });
    await this.badge('!');
  }
  // Every grant: the extension needs none to reach the server, which it calls with OAuth tokens.
  private async optionalGrants() {
    return (await this.api.permissions.getAll()).origins ?? [];
  }
  private async removeAccess() {
    const origins = await this.optionalGrants();
    if (origins.length) await this.api.permissions.remove({ origins });
    if ((await this.optionalGrants()).length) throw new Error('permission removal');
  }
  private granted(origins: string[]) {
    return this.api.permissions.contains({ origins, permissions: ['cookies'] });
  }
  // The grant a connection needs: all sites, or nothing, since added sites are granted one by one.
  private async allowed(settings: Pick<CaptureSettings, 'mode'>) {
    return settings.mode === 'all' ? this.granted([...browserOrigins]) : true;
  }
  private async grantedSites(sites: string[]) {
    const granted = await Promise.all(sites.map(site => this.granted(siteOrigins(site))));
    return sites.filter((_, index) => granted[index]);
  }
  private async revokeSites(sites: string[]) {
    if (sites.length) await this.api.permissions.remove({ origins: sites.flatMap(siteOrigins) });
  }
  // Removed sites lose their Chrome grant.
  private async changeSites(settings: CaptureSettings, sites: string[]) {
    const removed = settings.sites.filter(site => !sites.includes(site));
    await this.save({ status: { state: 'empty' } });
    await this.saveSettings({ ...settings, sites });
    if (settings.mode === 'sites' && removed.length) await this.revokeSites(removed);
    return removed.length > 0;
  }
  private interrupt() {
    this.epoch++;
    this.upload?.abort();
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => this.ready).then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  // An access token for a server request: the stored one, refreshed when it is about to expire.
  private async accessToken(): Promise<Access> {
    const tokens = await this.tokens();
    if (!tokens) return 'reconnect';
    if (tokens.expiresAt - Date.now() > refreshAheadMs) return tokens.access;
    return this.refresh();
  }
  // One refresh at a time: concurrent callers share it, since a second one would present a rotated token.
  private refresh(): Promise<Access> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  // Retries an attempt whose outcome is unknown while the server still answers the old token with the same tokens.
  // `invalid_grant` ends the connection, unless an earlier attempt may have rotated the token: the server refuses a
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
        last = await requestTokens(this.api.fetch, this.serverOrigin, { refreshToken: tokens.refresh }, timeout.signal);
      } finally {
        timeout.clear();
      }
      if (typeof last === 'object') {
        // Saved before anything else, so the rotated token is never lost. A connection that ended or changed
        // meanwhile (Disconnect, a new connect) keeps its own.
        const current = await this.tokens();
        if (current?.refresh !== tokens.refresh) return current?.access ?? 'reconnect';
        await this.api.storage.local.set({ [tokensKey]: last.tokens });
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
    if ((await this.tokens())?.refresh === tokens.refresh) await this.toReconnect();
    return 'reconnect';
  }
  // Every request to the server: the bearer token, never cookies (no grant on our site, so credentialed CORS would
  // fail). A 401 on a bearer request means the token was refused, as when signing out on the server's website revokes the
  // current access token: refresh once and retry. Throws when the server can't be reached for a token.
  private async call(path: string, init: RequestInit): Promise<globalThis.Response | 'reconnect'> {
    const token = await this.accessToken();
    if (token === 'reconnect') return 'reconnect';
    if (token === 'unavailable') throw new Error('unavailable');
    const send = (access: string) =>
      this.api.fetch(`${this.serverOrigin}${path}`, {
        ...init,
        credentials: 'omit',
        headers: { ...(init.headers as { [name: string]: string } | undefined), authorization: `Bearer ${access}` },
      });
    const response = await send(token);
    if (response.status !== 401) return response;
    const stored = await this.tokens();
    if (!stored) return 'reconnect';
    // A concurrent call may have refreshed already.
    const next = stored.access === token ? await this.refresh() : stored.access;
    if (next === 'reconnect') return 'reconnect';
    if (next === 'unavailable') throw new Error('unavailable');
    const retried = await send(next);
    if (retried.status !== 401) return retried;
    await this.toReconnect();
    return 'reconnect';
  }

  // Periodic capture, also run on Chrome startup.
  alarmFired(name: string): Promise<Response | undefined> {
    return name === syncAlarm ? this.automatic() : Promise.resolve(undefined);
  }
  // Captures the user did not ask for. The controller refuses them unless connected and not paused, and uploads only
  // on change. A build the server refused as outdated waits for an update rather than retrying every minute, and a
  // connection waiting for Reconnect captures nothing.
  private async automatic(): Promise<Response | undefined> {
    if (!(await this.tokens())) return;
    const { state } = await this.syncRecord();
    const refused = (await this.api.storage.local.get(refusedVersionKey))[refusedVersionKey];
    if (state === 'outdated' && refused === this.version) return;
    return (await this.handle({ type: 'capture' })) as Response;
  }
  // Chrome reports changes only for granted hosts: added sites, or every site with all-sites access.
  async cookieChanged({ cookie, removed, cause }: CookieChange) {
    // An overwrite reports a removal before the addition; expiry and eviction are not sign-outs.
    if (removed && cause !== 'explicit' && cause !== 'expired_overwrite') return;
    const settings = await this.settings();
    if (!settings.connected || settings.paused || cookieInSites(cookie, [this.serverSite])) return;
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
  // Losing the all-sites grant stops a capture in flight when the connection relies on it. A lost site grant is
  // reconciled after it instead, which also covers the grants this controller removes itself.
  permissionsRemoved(origins: string[] = []): Promise<void> {
    const allSites = origins.some(origin => (browserOrigins as readonly string[]).includes(origin));
    if (!origins.length) this.interrupt();
    // Use added sites only removes it after saving added-sites mode, which must not interrupt its own capture.
    else if (allSites)
      void this.settings().then(settings => {
        if (settings.mode === 'all') this.interrupt();
      });
    return this.enqueue(async () => {
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
        await this.api.storage.local.set({ [revokedKey]: [...new Set([...(await this.revokedSites()), ...revoked])] });
        const kept = settings.sites.filter(site => !revoked.includes(site));
        await this.changeSites(settings, kept);
        if (await this.tokens()) {
          const server = await this.change(settings, { removeSites: revoked });
          if (server && server !== 'reconnect') await this.reconcile({ ...settings, sites: kept }, server);
        }
      }
    });
  }
  private async status(): Promise<StatusResponse> {
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
      this.distribution === 'manual' && typeof latest === 'string' && compareVersions(latest, this.version) > 0
        ? { update: latest }
        : {};
    const tokens = await this.tokens();
    const stored = await this.account();
    const account: AccountState = !settings.connected
      ? { state: 'none' }
      : tokens
        ? { state: 'syncing', email: stored?.email ?? '' }
        : { state: 'reconnect', ...(stored ? { email: stored.email } : {}) };
    const connecting = (await this.flow()) ? { connecting: true as const } : {};
    const granted = settings.mode === 'sites' ? await this.grantedSites(settings.sites) : settings.sites;
    const ungrantedSites = settings.connected ? settings.sites.filter(site => !granted.includes(site)) : [];
    const config = await this.config();
    return {
      ok: true,
      capture: record.status,
      sync,
      settings,
      account,
      ...connecting,
      permissionGranted,
      ungrantedSites,
      config,
      ...update,
    };
  }
  // Uploads only when the capture differs from the last one the server accepted, and never retries on its own.
  // 'interrupted': pause, disconnect, clear, or exclusions interrupted the upload; success is then not recorded.
  // 'reconnect': the connection's tokens ended, or the account page turned sync off.
  private async sync(bundle: Capture, epoch: number): Promise<'done' | 'interrupted' | 'reconnect'> {
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
    let ended = false;
    let received: SyncSettings | undefined;
    try {
      const response = await this.call('/api/v1/captures', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [extensionVersionHeader]: this.version },
        body,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(uploadTimeoutMs)]),
      });
      if (response === 'reconnect') {
        ended = true;
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
          ended = response.status === 409 && error === 'sync_disconnected';
          if (response.status === 426) await this.api.storage.local.set({ [refusedVersionKey]: this.version });
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
      return 'reconnect';
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
      [pulledKey]: Date.now(),
      ...(body.config === undefined ? {} : { [configKey]: body.config }),
      ...(body.latestVersion ? { [latestVersionKey]: body.latestVersion } : {}),
    });
    if (!settings.connected) return settings;
    // A new period from the config takes effect now rather than at the next worker start.
    const { syncPeriodMinutes } = await this.config();
    if (!settings.paused && (await this.api.alarms.get(syncAlarm))?.periodInMinutes !== syncPeriodMinutes)
      await this.schedule();
    // The account page turned sync off. A connection waiting for its first upload since Connect lifts that.
    if (body.disconnected && !(await this.syncRecord()).connect) {
      await this.toReconnect();
      return settings;
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
        headers: { 'content-type': 'application/json', [extensionVersionHeader]: this.version },
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
      if (revoked.length) await this.api.storage.local.remove(revokedKey);
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
    if (next.paused && !settings.paused) await this.api.alarms.clear(syncAlarm);
    const removed = settings.sites.filter(site => !next.sites.includes(site));
    if (settings.mode === 'sites' && removed.length) await this.revokeSites(await this.grantedSites(removed));
    return next;
  }
  private async revokedSites(): Promise<string[]> {
    const stored = (await this.api.storage.local.get(revokedKey))[revokedKey];
    return Array.isArray(stored) ? stored.filter((site): site is string => typeof site === 'string') : [];
  }

  // `context.tab` is the sender's tab, which a connect tab returns to.
  async handle(input: unknown, context: { tab?: number | undefined } = {}): Promise<Response | ExchangeResponse> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };
    const request = parsed.data;
    if (['disconnect', 'clear', 'pause', 'sites', 'narrow', 'exchange'].includes(request.type)) this.interrupt();
    // Snapshot at arrival: a capture queued before an interrupting request is discarded.
    const epoch = this.epoch;
    return this.enqueue(async (): Promise<Response | ExchangeResponse> => {
      try {
        if (request.type === 'status') return await this.status();
        if (request.type === 'update') return await this.update();
        if (request.type === 'exchange') return await this.exchange(request.url);
        const settings = await this.settings();
        if (request.type === 'check') return await this.check(settings);
        if (request.type === 'clear') {
          await this.save({ status: { state: 'empty' } });
          return await this.status();
        }
        if (request.type === 'disconnect') return await this.disconnect();
        if (request.type === 'pause') {
          await this.save({ status: { state: 'empty' } });
          await this.saveSettings({ ...settings, paused: true });
          await this.api.alarms.clear(syncAlarm);
          // Paused here at once; the account is told now, or at the next fetch if this fails.
          if (settings.connected && (await this.tokens()))
            await this.change({ ...settings, paused: true }, { paused: true });
          return await this.status();
        }
        if (request.type === 'prepare') {
          if (request.connect === 'all' && this.distribution === 'store')
            return { ok: false, error: 'invalid_request' };
          const pending: Pending = {
            sites: request.sites,
            at: Date.now(),
            ...(request.connect ? { connect: request.connect } : {}),
            ...(context.tab === undefined ? {} : { tab: context.tab }),
          };
          await this.api.storage.session.set({ [pendingKey]: pending });
          return await this.status();
        }
        if (request.type === 'finish') {
          const pending = await this.pending();
          if (!pending) return await this.status();
          const needed = [...(pending.connect === 'all' ? browserOrigins : []), ...pending.sites.flatMap(siteOrigins)];
          // Not granted yet: keep it for the permission event, until it expires.
          if (!(await this.granted(needed))) return await this.status();
          await this.api.storage.session.remove(pendingKey);
          if (pending.connect)
            return await this.connect(settings, pending.connect, pending.sites, pending.tab ?? context.tab, epoch);
          if (!pending.sites.length) return await this.status();
          return await this.select(
            settings,
            [...settings.sites, ...pending.sites.filter(site => !settings.sites.includes(site))],
            epoch,
          );
        }
        if (request.type === 'connect') return await this.connect(settings, request.mode, [], context.tab, epoch);
        if (request.type === 'reconnect') {
          if (!settings.connected || (await this.tokens())) return { ok: false, error: 'invalid_request' };
          return await this.startFlow({ mode: settings.mode, sites: [], reconnect: true }, context.tab);
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
        // Sync now and the periodic capture fetch the account's settings when they are due.
        let current = settings;
        const due = this.pullDue(await this.config(), (await this.api.storage.local.get(pulledKey))[pulledKey]);
        if (due && (await this.tokens())) current = await this.pull(current);
        if (!current.connected) return await this.status();
        if (current.paused) return { ok: false, error: 'paused' };
        return await this.capture(current, epoch);
      } catch {
        // Browser and schema error details may contain cookie values.
        await this.save({ status: { state: 'failed' } }).catch(() => undefined);
        return { ok: false, error: 'capture_failed' };
      }
    }).catch(() => ({ ok: false, error: 'capture_failed' }));
  }
  // Update now, in store builds only: asks Chrome for the store's update and reloads into it when Chrome has one, which
  // ends this worker. Otherwise Chrome installs it later on its own (`noUpdate`).
  private async update(): Promise<Response> {
    if (this.distribution !== 'store') return { ok: false, error: 'invalid_request' };
    const { status } = await this.api.runtime.requestUpdateCheck();
    if (status === 'update_available') this.api.runtime.reload();
    return { ...(await this.status()), ...(status === 'update_available' ? {} : { noUpdate: true as const }) };
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
    if (mode === 'all' && this.distribution === 'store') return { ok: false, error: 'invalid_request' };
    if (!(await this.allowed({ mode }))) return { ok: false, error: 'permission_required' };
    if (await this.tokens()) {
      // The tokens may have ended without this browser knowing; a refresh tells.
      const access = await this.refresh();
      if (access === 'unavailable') return { ok: false, error: 'unavailable' };
      if (access !== 'reconnect') {
        const next = await this.applyConnect(settings, mode);
        await this.saveSettings(next);
        await this.saveSync({ state: 'never', connect: true });
        await this.schedule();
        await this.badge('');
        return await this.afterConnect(next, sites, epoch);
      }
    }
    return await this.startFlow({ mode, sites, reconnect: false }, opener);
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
  private async afterConnect(next: CaptureSettings, sites: string[], epoch: number, resume = true): Promise<Response> {
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
  // Opens the server's authorize URL in a tab next to the one the click came from, which signs the user in if
  // needed. A new flow replaces an earlier one.
  private async startFlow(
    flow: Pick<Flow, 'mode' | 'sites' | 'reconnect'>,
    from: number | undefined,
  ): Promise<Response> {
    const opener = from ?? (await this.api.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
    const { verifier, challenge } = await pkce();
    const state = newState();
    const stored: Flow = { ...flow, state, verifier, at: Date.now(), ...(opener === undefined ? {} : { opener }) };
    await this.api.storage.session.set({ [flowKey]: stored });
    const url = authorizeUrl(this.serverOrigin, this.redirectUri, { state, challenge });
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
    return await this.status();
  }
  // The redirect page's code. Only the state of a flow this extension started, from this extension's server (`iss`), and each
  // verifier once: the server revokes the tokens a replayed code issued. Nothing is written until /me names the
  // account, so an unknown account never is.
  private async exchange(url: string): Promise<Response | ExchangeResponse> {
    const redirect = readRedirect(url, this.redirectUri);
    if (!redirect) return { ok: false, error: 'invalid_request' };
    const flow = await this.flow();
    // A redirect that isn't this flow's leaves the flow usable.
    if (!flow || redirect.state !== flow.state) return { ok: false, error: 'expired' };
    await this.api.storage.session.remove(flowKey);
    if (redirect.iss !== issuerOf(this.serverOrigin)) return { ok: false, error: 'invalid_request' };
    if ('error' in redirect) return { ok: false, error: 'denied' };
    const result = await requestTokens(
      this.api.fetch,
      this.serverOrigin,
      { code: redirect.code, verifier: flow.verifier, redirectUri: this.redirectUri },
      AbortSignal.timeout(checkTimeoutMs),
    );
    if (typeof result !== 'object') return { ok: false, error: 'unavailable' };
    const { tokens } = result;
    const me = await this.me(tokens.access);
    if (!me) {
      // Best effort: the server lists the browser from its code exchange, so this disconnects it. If this fails too,
      // the account page lists it until it is disconnected there or unused for 30 days.
      await this.api
        .fetch(`${this.serverOrigin}/api/v1/captures`, {
          method: 'DELETE',
          credentials: 'omit',
          headers: { authorization: `Bearer ${tokens.access}` },
          signal: AbortSignal.timeout(deleteTimeoutMs),
        })
        .catch(() => undefined);
      return { ok: false, error: 'unavailable' };
    }
    const previous = await this.account();
    const before = await this.settings();
    // A different account starts fresh, without the previous account's sites, exclusions or capture. A Reconnect
    // that turns out to be a different account lands in added-sites mode, so nothing is synced it didn't agree to.
    const fresh = !previous || previous.id !== me.id;
    const start: CaptureSettings = fresh ? { ...before, sites: [], excludedDomains: [] } : before;
    const next = await this.applyConnect(start, fresh && flow.reconnect ? 'sites' : flow.mode);
    // Reconnect skips the disclosure, so it never resumes a sync the user paused.
    if (flow.reconnect && !fresh) next.paused = before.paused;
    if (fresh) {
      await this.save({ status: { state: 'empty' } });
      await this.api.storage.local.remove(revokedKey);
      await this.api.storage.local.remove(pulledKey);
    }
    const sync: SyncRecord = { state: 'never', connect: true };
    await this.api.storage.local.set({
      [tokensKey]: tokens,
      [accountKey]: { id: me.id, email: me.email },
      [settingsKey]: next,
      [syncKey]: sync,
    });
    if (!next.paused) await this.schedule();
    await this.badge('');
    // Only after saving, so the permission events find nothing to revoke.
    if (fresh) {
      await this.revokeSites(await this.grantedSites(before.sites.filter(site => !flow.sites.includes(site))));
      if (flow.reconnect) await this.api.permissions.remove({ origins: [...browserOrigins] });
    }
    void this.enqueue(async () => {
      try {
        await this.afterConnect(await this.settings(), flow.sites, this.epoch, !flow.reconnect);
      } catch {
        await this.save({ status: { state: 'failed' } }).catch(() => undefined);
      }
    });
    return { ok: true, email: me.email, ...(flow.opener === undefined ? {} : { opener: flow.opener }) };
  }
  // The account behind a fresh access token. Retried once after a network error or 5xx.
  private async me(access: string): Promise<Account | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await sleep(1_000);
      try {
        const response = await this.api.fetch(`${this.serverOrigin}/api/v1/me`, {
          credentials: 'omit',
          headers: { authorization: `Bearer ${access}` },
          signal: AbortSignal.timeout(checkTimeoutMs),
        });
        const me = meSchema.safeParse(await response.json().catch(() => undefined));
        if (response.ok && me.success) return { id: me.data.user.id, email: me.data.user.email };
        if (response.status < 500) return undefined;
      } catch {
        // Retried below.
      }
    }
    return undefined;
  }
  // Use added sites only: records added-sites mode, then removes the all-sites grant, which takes the added sites'
  // grants too. The popup requests those again in the same click; Chrome restores them without a prompt, since it
  // still records them as granted. The connection stays.
  private async narrow(settings: CaptureSettings): Promise<Response> {
    if (!settings.connected || settings.mode !== 'all') return { ok: false, error: 'invalid_request' };
    await this.save({ status: { state: 'empty' } });
    await this.saveSettings({ ...settings, mode: 'sites' });
    await this.api.permissions.remove({ origins: [...browserOrigins] });
    return await this.status();
  }
  // Deletes the uploaded copy with the bearer token, which also disconnects this browser on the server; never
  // /oauth2/revoke, which the server refuses for the extension. Local state goes whatever the server says.
  private async disconnect(): Promise<Response> {
    await this.disable();
    let deleted = false;
    try {
      if (await this.tokens()) {
        const response = await this.call('/api/v1/captures', {
          method: 'DELETE',
          signal: AbortSignal.timeout(deleteTimeoutMs),
        });
        deleted = response !== 'reconnect' && response.ok;
      }
    } catch {
      // Not confirmed, so reported below.
    } finally {
      await this.api.storage.local.remove(tokensKey);
      await this.badge('');
      if (!deleted) await this.saveSync({ state: 'delete_failed' });
      await this.removeAccess();
    }
    return await this.status();
  }
  // Opening the popup or the setup tab fetches the account's settings.
  private async check(settings: CaptureSettings): Promise<Response> {
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
  // Excluded domains, and the Agent Computers site itself, are never added.
  private blocked(site: string, excludedDomains: string[]) {
    return site === this.serverSite || excludedDomains.some(domain => within(site, domain));
  }
  private get serverSite() {
    return siteOfHost(new URL(this.serverOrigin).hostname);
  }
  // Waiting for Reconnect, nothing is captured.
  private async capture(settings: CaptureSettings, epoch: number): Promise<Response> {
    if (epoch !== this.epoch) return { ok: false, error: 'permission_required' };
    if (!(await this.tokens())) return await this.status();
    const startedAt = new Date().toISOString();
    await this.save({ status: { state: 'capturing' } });
    // Current non-incognito store only. Empty partitionKey includes all partitions.
    // Excluded values never reach storage, messages, UI, logs, or the server. Chrome returns only granted sites; the
    // Agent Computers session itself is never synced.
    // The account may list sites this browser has not granted; those are not captured until the user grants them.
    const sites = settings.mode === 'sites' ? await this.grantedSites(settings.sites) : [];
    const allCookies = await this.api.cookies.getAll({ partitionKey: {} });
    const cookies = allCookies.filter(
      cookie =>
        !cookieExcluded(cookie, settings.excludedDomains) &&
        !cookieInSites(cookie, [this.serverSite]) &&
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
    return await this.status();
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
  if (['popup.html', 'setup.html'].some(page => sender.url === `${base}${page}`)) return !exchange;
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
