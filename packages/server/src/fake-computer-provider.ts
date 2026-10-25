import type { CdpCookieParam } from '@agent-computers/apply';
import { siteOfHost } from '@agent-computers/capture';
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
  cookies: CdpCookieParam[];
  paused: boolean;
  // Created before computers were private, so live view refuses it.
  public?: boolean;
  timeZone?: string;
  // The text live view's paste last set as the clipboard.
  clipboard?: string;
  // The helper revision it runs: the provider's when it was created, like a current template.
  revision: string;
};
// In-memory provider for tests. It records calls and keeps a Chrome-like cookie jar per computer;
// it is NOT evidence about E2B or Chrome.
export function fakeComputerProvider() {
  const sandboxes = new Map<string, FakeSandbox>();
  const calls = {
    create: 0,
    kill: 0,
    sync: 0,
    pause: 0,
    timeouts: [] as number[],
    // A connected session's setTimeout, and the provider's own (which never wakes a computer).
    setTimeouts: [] as number[],
    providerTimeouts: [] as number[],
    // Live view stream starts, by sandbox.
    streams: [] as string[],
    syncBudgets: [] as (number | undefined)[],
    timeZones: [] as string[],
    // Refreshes and cookie syncs, in order.
    steps: [] as ('refresh' | 'sync')[],
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
  // Where stream() points: a test's own WebSocket server for relay tests.
  let streamUrl = 'wss://stream.example.test/';
  // Like Storage.setCookies: a cookie replaces the one with its identity, and an expired one deletes it.
  const setCookies = (sandbox: FakeSandbox, cookies: CdpCookieParam[]) => {
    for (const cookie of cookies) {
      const key = jarKey(cookie);
      sandbox.cookies = sandbox.cookies.filter(existing => jarKey(existing) !== key);
      if (cookie.expires === undefined || cookie.expires > Date.now() / 1000) sandbox.cookies.push(cookie);
    }
  };
  const provider: ComputerProvider = {
    get revision() {
      return revision;
    },
    async find(computerId) {
      return [...sandboxes].find(([, sandbox]) => sandbox.computerId === computerId)?.[0] ?? null;
    },
    async create(computerId, timeoutMs) {
      calls.create++;
      calls.timeouts.push(timeoutMs);
      await new Promise(resolve => setTimeout(resolve, createDelayMs));
      const id = `sandbox-${calls.create}`;
      sandboxes.set(id, { computerId, actions: [], tabs: ['about:blank'], cookies: [], paused: false, revision });
      return id;
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
        downloadUrl: async path => `https://files.example.test/${sandboxId}${path}`,
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
        async setClipboard(text) {
          if (clipboardFails) throw new Error('setClipboard failed in fake');
          sandbox.clipboard = text;
        },
        async syncCookies({ clearSites, cookies, budgetMs }) {
          calls.sync++;
          calls.steps.push('sync');
          calls.syncBudgets.push(budgetMs);
          if (syncFails) throw new Error('sync failed in fake');
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
    setStreamUrl: (url: string) => {
      streamUrl = url;
    },
  };
}
