import type { CdpCookieParam } from '@clutchbox/apply';
import { siteOfHost } from '@clutchbox/capture';
import { type ComputerSize, FIRST_PROFILE } from '@clutchbox/computer';
import type { ComputerAction, ComputerProvider } from './computers';

const cookieHost = (cookie: CdpCookieParam) => cookie.domain ?? new URL(cookie.url!).hostname;
export const cookieSite = (cookie: CdpCookieParam) => siteOfHost(cookieHost(cookie));
// Chrome's identity for a cookie: a domain attribute always gets a leading dot, a URL sets a host-only cookie.
const jarKey = (cookie: CdpCookieParam) =>
  JSON.stringify([
    cookie.name,
    cookie.domain ? `.${cookie.domain.replace(/^\./, '')}` : cookieHost(cookie),
    cookie.path,
    cookie.partitionKey?.topLevelSite ?? null,
    cookie.partitionKey?.hasCrossSiteAncestor ?? null,
  ]);

type FakeSandbox = {
  computerId: string;
  actions: ComputerAction[];
  // Open tabs' URLs, like Chrome's: a computer starts with one blank tab.
  tabs: string[];
  // The profile Chrome runs, FIRST_PROFILE until useProfile, and its cookie jar; other profiles' jars by profile.
  profile: string;
  cookies: CdpCookieParam[];
  profiles: Record<string, CdpCookieParam[]>;
  paused: boolean;
  // Created before computers were private, so live view refuses it.
  public?: boolean;
  timeZone?: string;
  // The text live view's paste last set as the clipboard.
  clipboard?: string;
  // The helper revision it runs: the provider's when it was created, like a current template.
  revision: string;
  // The snapshot it was made from, for a fork.
  snapshotId?: string;
};
// What a snapshot keeps of its computer: the browser's state and the system's.
type FakeSnapshot = Pick<FakeSandbox, 'tabs' | 'profile' | 'cookies' | 'profiles' | 'revision' | 'timeZone' | 'public'>;
// In-memory provider for tests. It records calls and keeps a Chrome-like cookie jar per computer;
// it is NOT evidence about E2B or Chrome.
// `account` prefixes its IDs, so two fakes, as two provider accounts, never share one.
export function fakeComputerProvider({ account = '' }: { account?: string } = {}) {
  const sandboxes = new Map<string, FakeSandbox>();
  const snapshots = new Map<string, FakeSnapshot>();
  // Every computer made, for its ID; calls.create counts those from the template, calls.fork those from a snapshot.
  let made = 0;
  const calls = {
    create: 0,
    fork: 0,
    snapshot: 0,
    deleteSnapshot: 0,
    kill: 0,
    sync: 0,
    pause: 0,
    timeouts: [] as number[],
    // The size of each computer created.
    sizes: [] as ComputerSize[],
    // A connected session's setTimeout, and the provider's own (which never wakes a computer).
    setTimeouts: [] as number[],
    providerTimeouts: [] as number[],
    // Live view stream starts, by sandbox.
    streams: [] as string[],
    // CDP bridge starts, by sandbox.
    cdpEndpoints: [] as string[],
    syncBudgets: [] as (number | undefined)[],
    timeZones: [] as string[],
    // Refreshes, profile switches, and cookie syncs, in order.
    steps: [] as ('refresh' | 'profile' | 'sync')[],
    // Each useProfile, with the sandbox and the profile asked for: the profile each session ran on.
    profiles: [] as { sandboxId: string; profile: string }[],
  };
  let revision = 'revision-1';
  let createDelayMs = 0;
  let syncFails = false;
  let syncDelayMs = 0;
  let setTimeoutFails = false;
  let closeTabsFails = false;
  let timeZoneFails = false;
  let refreshFails = false;
  let clipboardFails = false;
  let snapshotFails = false;
  let useProfileFails = false;
  let createFromSnapshotFails = false;
  // Where stream() points: a test's own WebSocket server for relay tests.
  let streamUrl = 'wss://stream.example.test/';
  // Where cdpEndpoint() points: a test's own WebSocket server standing in for Chrome.
  let cdpUrl = 'wss://cdp.example.test/';
  // Like Storage.setCookies: a cookie replaces the one with its identity, and an expired one deletes it.
  const setCookies = (sandbox: FakeSandbox, cookies: CdpCookieParam[]) => {
    for (const cookie of cookies) {
      const key = jarKey(cookie);
      sandbox.cookies = sandbox.cookies.filter(existing => jarKey(existing) !== key);
      if (cookie.expires === undefined || cookie.expires > Date.now() / 1000) sandbox.cookies.push(cookie);
    }
  };
  const provider: ComputerProvider = {
    name: 'fake',
    get revision() {
      return revision;
    },
    async find(computerId) {
      return [...sandboxes].find(([, sandbox]) => sandbox.computerId === computerId)?.[0] ?? null;
    },
    async create(computerId, timeoutMs, size) {
      calls.create++;
      calls.timeouts.push(timeoutMs);
      calls.sizes.push(size);
      await new Promise(resolve => setTimeout(resolve, createDelayMs));
      const id = `${account}sandbox-${++made}`;
      sandboxes.set(id, {
        computerId,
        actions: [],
        tabs: ['about:blank'],
        profile: FIRST_PROFILE,
        cookies: [],
        profiles: {},
        paused: false,
        revision,
      });
      return id;
    },
    async createFromSnapshot(snapshotId, computerId, timeoutMs) {
      calls.fork++;
      calls.timeouts.push(timeoutMs);
      if (createFromSnapshotFails) throw new Error('createFromSnapshot failed in fake');
      const snapshot = snapshots.get(snapshotId);
      if (!snapshot) throw new Error('snapshot not found');
      const id = `${account}sandbox-${++made}`;
      sandboxes.set(id, {
        ...structuredClone(snapshot),
        computerId,
        snapshotId,
        actions: [],
        paused: false,
      });
      return id;
    },
    async snapshot(sandboxId, timeoutMs) {
      calls.snapshot++;
      calls.timeouts.push(timeoutMs);
      const sandbox = sandboxes.get(sandboxId);
      if (!sandbox) throw new Error('sandbox not found');
      if (snapshotFails) throw new Error('snapshot failed in fake');
      // Like E2B: a paused computer is resumed to take it.
      sandbox.paused = false;
      const id = `${account}snapshot-${calls.snapshot}`;
      const { tabs, profile, cookies, profiles, revision: helpers, timeZone, public: open } = sandbox;
      snapshots.set(
        id,
        structuredClone({
          tabs,
          profile,
          cookies,
          profiles,
          revision: helpers,
          ...(timeZone ? { timeZone } : {}),
          ...(open ? { public: open } : {}),
        }),
      );
      return id;
    },
    async deleteSnapshot(snapshotId) {
      calls.deleteSnapshot++;
      if ([...sandboxes.values()].some(sandbox => sandbox.snapshotId === snapshotId))
        throw new Error('snapshot in use in fake');
      snapshots.delete(snapshotId);
    },
    async connect(sandboxId, timeoutMs) {
      calls.timeouts.push(timeoutMs);
      const sandbox = sandboxes.get(sandboxId);
      if (!sandbox) throw new Error('sandbox not found');
      sandbox.paused = false;
      return {
        isPrivate: !sandbox.public,
        screenshot: async () => new Uint8Array([137, 80, 78, 71]),
        act: async action => {
          sandbox.actions.push(action);
        },
        cdp: async ({ method }) =>
          JSON.stringify(
            method === 'Target.getTargets'
              ? { result: { targetInfos: [] } }
              : { error: { message: 'unsupported in fake' } },
          ),
        exec: async ({ command }) =>
          command.startsWith('stat')
            ? { exitCode: 0, stdout: '8\n', stderr: '', truncated: false, timedOut: false }
            : { exitCode: 0, stdout: `ran: ${command}`, stderr: '', truncated: false, timedOut: false },
        async closeTabs() {
          if (closeTabsFails) throw new Error('closeTabs failed in fake');
          sandbox.tabs = ['about:blank'];
        },
        async setTimeout(ms) {
          if (setTimeoutFails) throw new Error('setTimeout failed in fake');
          calls.setTimeouts.push(ms);
        },
        async refresh() {
          calls.steps.push('refresh');
          if (refreshFails) throw new Error('refresh failed in fake');
          if (sandbox.revision === revision) return 'current';
          // Like a Chrome restart: tabs close, cookies stay.
          sandbox.revision = revision;
          sandbox.tabs = ['about:blank'];
          return 'refreshed';
        },
        // Like a Chrome restart on another user data directory: tabs close, and each profile keeps its own cookies.
        async useProfile(profile) {
          calls.steps.push('profile');
          calls.profiles.push({ sandboxId, profile });
          if (useProfileFails) throw new Error('useProfile failed in fake');
          if (profile === sandbox.profile) return;
          sandbox.profiles[sandbox.profile] = sandbox.cookies;
          sandbox.cookies = sandbox.profiles[profile] ?? [];
          delete sandbox.profiles[profile];
          sandbox.profile = profile;
          sandbox.tabs = ['about:blank'];
        },
        async setTimeZone(timeZone) {
          calls.timeZones.push(timeZone);
          if (timeZoneFails) throw new Error('setTimeZone failed in fake');
          sandbox.timeZone = timeZone;
        },
        async stream() {
          calls.streams.push(sandboxId);
          return {
            url: streamUrl,
            headers: { 'e2b-traffic-access-token': `token-${sandboxId}`, origin: 'agent-computers-relay' },
          };
        },
        async cdpEndpoint() {
          if (sandbox.public) throw new Error('computer accepts public traffic');
          calls.cdpEndpoints.push(sandboxId);
          return {
            url: cdpUrl,
            headers: { 'e2b-traffic-access-token': `token-${sandboxId}`, origin: 'agent-computers-relay' },
          };
        },
        async setClipboard(text) {
          if (clipboardFails) throw new Error('setClipboard failed in fake');
          sandbox.clipboard = text;
        },
        async syncCookies({ profile, clearSites, cookies, budgetMs }) {
          calls.sync++;
          calls.steps.push('sync');
          calls.syncBudgets.push(budgetMs);
          if (syncFails) throw new Error('sync failed in fake');
          if (profile !== sandbox.profile) throw new Error('Chrome runs another profile in fake');
          // Like the E2B helper: a sync that would outlast its budget gives up without writing.
          if (syncDelayMs > budgetMs) {
            await new Promise(resolve => setTimeout(resolve, budgetMs));
            throw new Error('sync budget exceeded in fake');
          }
          await new Promise(resolve => setTimeout(resolve, syncDelayMs));
          const clear = new Set(clearSites);
          const kept = sandbox.cookies.filter(cookie => !clear.has(cookieSite(cookie)));
          const cleared = sandbox.cookies.length - kept.length;
          sandbox.cookies = kept;
          setCookies(sandbox, cookies);
          return { kept: kept.length, cleared, set: cookies.length };
        },
      };
    },
    async pause(sandboxId) {
      const sandbox = sandboxes.get(sandboxId);
      if (!sandbox) throw new Error('sandbox not found');
      calls.pause++;
      sandbox.paused = true;
    },
    async setTimeout(sandboxId, timeoutMs) {
      if (!sandboxes.has(sandboxId)) throw new Error('sandbox not found');
      if (setTimeoutFails) throw new Error('setTimeout failed in fake');
      calls.providerTimeouts.push(timeoutMs);
    },
    async kill(sandboxId) {
      calls.kill++;
      sandboxes.delete(sandboxId);
    },
  };
  return {
    provider,
    sandboxes,
    snapshots,
    calls,
    slowCreate: (ms: number) => {
      createDelayMs = ms;
    },
    failSync: (fails = true) => {
      syncFails = fails;
    },
    slowSync: (ms: number) => {
      syncDelayMs = ms;
    },
    failSetTimeout: (fails = true) => {
      setTimeoutFails = fails;
    },
    failCloseTabs: (fails = true) => {
      closeTabsFails = fails;
    },
    failTimeZone: (fails = true) => {
      timeZoneFails = fails;
    },
    // A provider update: computers made before it are behind.
    setRevision: (next: string) => {
      revision = next;
    },
    failRefresh: (fails = true) => {
      refreshFails = fails;
    },
    failClipboard: (fails = true) => {
      clipboardFails = fails;
    },
    failSnapshot: (fails = true) => {
      snapshotFails = fails;
    },
    failUseProfile: (fails = true) => {
      useProfileFails = fails;
    },
    failCreateFromSnapshot: (fails = true) => {
      createFromSnapshotFails = fails;
    },
    setStreamUrl: (url: string) => {
      streamUrl = url;
    },
    setCdpUrl: (url: string) => {
      cdpUrl = url;
    },
  };
}
