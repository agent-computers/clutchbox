import { z } from 'zod';
import { companions, type SuggestedSite, suggestedSites } from './sites';
import { siteOfHost } from './sync';

export const browserOrigins = ['http://*/*', 'https://*/*'] as const;
// Chrome rejects `*://` patterns against the optional `http://*/*` and `https://*/*` grants, so both schemes are named.
export const siteOrigins = (site: string) => [`https://*.${site}/*`, `http://*.${site}/*`];
// The added sites named by host permission patterns, as siteOrigins writes them.
export const sitesOfOrigins = (origins: string[]) => [
  ...new Set(origins.flatMap(origin => /^https?:\/\/\*\.([^/*]+)\/\*$/.exec(origin)?.[1] ?? [])),
];
export const serverOrigins = (serverOrigin: string) => [`${serverOrigin}/*`];

// Canonical hostnames only: no URLs, paths, ports or wildcard patterns.
export const domainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((input, context) => {
    if (/[/:?#@*%\s\\]/.test(input)) {
      context.addIssue({ code: 'custom', message: 'Enter a domain, such as example.com.' });
      return z.NEVER;
    }
    try {
      const host = new URL(`https://${input}`).hostname.replace(/\.$/, '').toLowerCase();
      if (!host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error();
      return host;
    } catch {
      context.addIssue({ code: 'custom', message: 'Enter a valid domain.' });
      return z.NEVER;
    }
  });
export const exclusionsSchema = z
  .array(domainSchema)
  .max(100)
  .transform(domains => [...new Set(domains)].sort());
// Added sites are registrable domains: adding mail.google.com adds google.com and its subdomains.
export const sitesSchema = z
  .array(
    domainSchema
      .refine(host => !/^[0-9.]+$/.test(host), { message: 'Enter a domain, not an IP address.' })
      .transform(siteOfHost),
  )
  .max(100)
  .transform(sites => [...new Set(sites)].sort());
// Accepts a domain or a pasted address, such as https://mail.google.com/inbox.
export function siteOfInput(input: string): string | undefined {
  const trimmed = input.trim();
  let host = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      host = new URL(trimmed).hostname;
    } catch {
      return undefined;
    }
  }
  const parsed = sitesSchema.safeParse([host]);
  return parsed.success ? parsed.data[0] : undefined;
}
// 'sites' captures only added sites, each behind its own Chrome grant; 'all' is the explicit all-sites choice.
export const captureModeSchema = z.enum(['sites', 'all']);
export type CaptureMode = z.infer<typeof captureModeSchema>;
export const settingsSchema = z
  .object({
    consentVersion: z.literal(2),
    connected: z.boolean(),
    paused: z.boolean(),
    mode: captureModeSchema,
    sites: sitesSchema,
    excludedDomains: exclusionsSchema,
  })
  .strict();
export type CaptureSettings = z.infer<typeof settingsSchema>;
export const defaultSettings = (): CaptureSettings => ({
  consentVersion: 2,
  connected: false,
  paused: false,
  mode: 'sites',
  sites: [],
  excludedDomains: [],
});
// Version 1 consent was to whole-browser access, so those settings become 'all'.
const legacySettingsSchema = z
  .object({
    consentVersion: z.literal(1),
    connected: z.boolean(),
    paused: z.boolean(),
    excludedDomains: exclusionsSchema,
  })
  .strict();
export function parseSettings(stored: unknown): CaptureSettings {
  const current = settingsSchema.safeParse(stored);
  if (current.success) return current.data;
  const legacy = legacySettingsSchema.safeParse(stored);
  return legacy.success ? { ...legacy.data, consentVersion: 2, mode: 'all', sites: [] } : defaultSettings();
}

export const cookieSchema = z
  .object({
    name: z.string().max(4096),
    value: z.string().max(16384),
    // A hostname, with a leading dot for a domain cookie: anything else could name one site to the scope check and
    // another to whoever sets the cookie by URL.
    domain: z
      .string()
      .min(1)
      .max(253)
      .regex(/^\.?[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?$/i),
    hostOnly: z.boolean(),
    path: z.string().startsWith('/').max(4096),
    secure: z.boolean(),
    httpOnly: z.boolean(),
    sameSite: z.enum(['no_restriction', 'lax', 'strict', 'unspecified']),
    session: z.boolean(),
    expirationDate: z.number().finite().nonnegative().optional(),
    storeId: z.string().min(1),
    partitionKey: z.object({ topLevelSite: z.url(), hasCrossSiteAncestor: z.boolean() }).strict().optional(),
  })
  .strict()
  .refine(cookie => cookie.session === (cookie.expirationDate === undefined), {
    message: 'Invalid cookie lifetime metadata',
  })
  .refine(cookie => !cookie.hostOnly || !cookie.domain.startsWith('.'), {
    message: 'Invalid host-only cookie domain',
  });
export type CapturedCookie = z.infer<typeof cookieSchema>;
export const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
export const cookieInSites = (cookie: { domain: string }, sites: string[]) =>
  sites.some(site => within(cookie.domain.replace(/^\./, '').toLowerCase(), site));

export function cookieExcluded(
  cookie: { domain: string; hostOnly: boolean; partitionKey?: { topLevelSite?: string | undefined } | undefined },
  exclusions: string[],
): boolean {
  const host = cookie.domain.replace(/^\./, '').toLowerCase();
  const partitionHost = cookie.partitionKey?.topLevelSite
    ? new URL(cookie.partitionKey.topLevelSite).hostname.toLowerCase()
    : undefined;
  return exclusions.some(
    excluded =>
      within(host, excluded) ||
      // A parent domain cookie would also authenticate the excluded subdomain.
      (!cookie.hostOnly && within(excluded, host)) ||
      // Do not retain cookies partitioned under an excluded top-level site.
      (partitionHost !== undefined && (within(partitionHost, excluded) || within(excluded, partitionHost))),
  );
}

export const captureSchema = z
  .object({
    schemaVersion: z.literal(2),
    id: z.uuid(),
    scope: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('whole-browser'), excludedDomains: exclusionsSchema }).strict(),
      z.object({ mode: z.literal('sites'), sites: sitesSchema, excludedDomains: exclusionsSchema }).strict(),
    ]),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    consistency: z.literal('non-atomic-cookie-read'),
    coverage: z.literal('cookies-only'),
    storeId: z.string().min(1),
    cookies: z.array(cookieSchema).max(50000),
  })
  .strict()
  .superRefine((capture, context) => {
    if (capture.completedAt < capture.startedAt)
      context.addIssue({ code: 'custom', message: 'Invalid capture interval' });
    if (
      capture.cookies.some(
        cookie =>
          cookieExcluded(cookie, capture.scope.excludedDomains) ||
          (capture.scope.mode === 'sites' && !cookieInSites(cookie, capture.scope.sites)) ||
          cookie.storeId !== capture.storeId,
      )
    ) {
      context.addIssue({ code: 'custom', message: 'Cookie outside capture scope' });
    }
  });
export type Capture = z.infer<typeof captureSchema>;

// What the server holds for each account. The server's website may only narrow it, except exclusions, which it
// edits either way; adding sites and resuming come from the extension, so the extension stays the source of consent.
export const syncSettingsSchema = z
  .object({ sites: sitesSchema, excludedDomains: exclusionsSchema, paused: z.boolean() })
  .strict();
export type SyncSettings = z.infer<typeof syncSettingsSchema>;
// PATCH /api/v1/sync. Exclusions replace the list; added sites inside a new exclusion are removed.
export const syncChangeSchema = z
  .object({
    addSites: sitesSchema.optional(),
    removeSites: sitesSchema.optional(),
    excludedDomains: exclusionsSchema.optional(),
    paused: z.boolean().optional(),
  })
  .strict();
export type SyncChange = z.infer<typeof syncChangeSchema>;
// Applies a change: excluded sites leave, and a site can't be both added and removed.
export function applySyncChange(settings: SyncSettings, change: SyncChange, serverSite: string): SyncSettings {
  const excludedDomains = change.excludedDomains ?? settings.excludedDomains;
  const removed = new Set(change.removeSites);
  const sites = [...new Set([...settings.sites, ...(change.addSites ?? [])])]
    .filter(site => !removed.has(site) && site !== serverSite && !excludedDomains.some(domain => within(site, domain)))
    .sort();
  return { sites, excludedDomains, paused: change.paused ?? settings.paused };
}
// Keeps only what the settings allow: the server applies it to every upload and to the stored capture, so a stale
// extension can't store a removed site or an excluded domain.
export function narrowCapture(capture: Capture, settings: Pick<SyncSettings, 'sites' | 'excludedDomains'>): Capture {
  const { scope } = capture;
  const sites = scope.mode === 'sites' ? scope.sites.filter(site => settings.sites.includes(site)) : undefined;
  return {
    ...capture,
    scope: scope.mode === 'sites' ? { ...scope, sites: sites ?? [] } : scope,
    cookies: capture.cookies.filter(
      cookie =>
        !cookieExcluded(cookie, settings.excludedDomains) && (sites === undefined || cookieInSites(cookie, sites)),
    ),
  };
}

// What the server tunes without an extension release. The extension clamps every value and falls back to
// these defaults for anything missing or invalid.
export interface ExtensionConfig {
  suggestedSites: SuggestedSite[];
  companions: { [site: string]: string[] };
  // The periodic capture, which uploads only on change.
  syncPeriodMinutes: number;
  // How often the extension fetches its settings when nothing else does.
  settingsRefreshMinutes: number;
  // Sign-ins and sign-outs start a quick capture once changes pause for quickQuietMs, at most quickWaitMs after the
  // first, and at most once per quickIntervalMs.
  quickQuietMs: number;
  quickWaitMs: number;
  quickIntervalMs: number;
  // Under the 4.5 MB request body limit of common serverless hosts; servers accept up to 4 MB.
  maxUploadBytes: number;
}
export const defaultExtensionConfig: ExtensionConfig = {
  suggestedSites: suggestedSites.map(site => ({ ...site, sites: [...site.sites] })),
  companions: Object.fromEntries(Object.entries(companions).map(([site, related]) => [site, [...related]])),
  syncPeriodMinutes: 1,
  settingsRefreshMinutes: 15,
  quickQuietMs: 2_000,
  quickWaitMs: 4_000,
  quickIntervalMs: 10_000,
  maxUploadBytes: 4_000_000,
};
const bounded = (min: number, max: number, fallback: number) =>
  z
    .number()
    .finite()
    .transform(value => Math.min(Math.max(Math.round(value), min), max))
    .catch(fallback);
// Icons load from the Clutchbox site only, so no other site learns which suggestions a user sees.
const iconSchema = z
  .string()
  .max(200)
  .regex(/^\/(?!\/)[\w\-./]+$/)
  .refine(path => !path.split('/').includes('..'));
const suggestedSiteSchema = z.object({
  name: z.string().trim().min(1).max(60),
  detail: z.string().trim().max(120).optional(),
  category: z.string().trim().min(1).max(40),
  sites: sitesSchema.refine(sites => sites.length > 0),
  icon: iconSchema.optional().catch(undefined),
});
const configSchema = z.object({
  suggestedSites: z
    .array(z.unknown())
    .max(200)
    .transform(rows => rows.flatMap(row => suggestedSiteSchema.safeParse(row).data ?? []))
    .catch(defaultExtensionConfig.suggestedSites),
  companions: z
    .record(z.string(), z.unknown())
    .transform(entries =>
      Object.fromEntries(
        Object.entries(entries).flatMap(([site, related]) => {
          const key = sitesSchema.safeParse([site]).data;
          const value = sitesSchema.safeParse(related).data;
          return key?.length === 1 && key[0] === site && value ? [[site, value.slice(0, 10)]] : [];
        }),
      ),
    )
    .catch(defaultExtensionConfig.companions),
  // Chrome's alarms fire at most every 30 seconds.
  syncPeriodMinutes: bounded(1, 60, defaultExtensionConfig.syncPeriodMinutes),
  settingsRefreshMinutes: bounded(1, 60, defaultExtensionConfig.settingsRefreshMinutes),
  quickQuietMs: bounded(500, 60_000, defaultExtensionConfig.quickQuietMs),
  quickWaitMs: bounded(500, 120_000, defaultExtensionConfig.quickWaitMs),
  quickIntervalMs: bounded(5_000, 600_000, defaultExtensionConfig.quickIntervalMs),
  maxUploadBytes: bounded(100_000, 4_000_000, defaultExtensionConfig.maxUploadBytes),
});
export function parseExtensionConfig(input: unknown): ExtensionConfig {
  const object = input && typeof input === 'object' ? input : {};
  const parsed = configSchema.parse({ ...defaultExtensionConfig, ...object });
  return { ...parsed, quickWaitMs: Math.max(parsed.quickWaitMs, parsed.quickQuietMs) };
}
// GET /api/v1/sync. `disconnected`: Delete everything or the account page turned sync off until the extension
// reconnects.
export const syncResponseSchema = z.object({
  settings: syncSettingsSchema.nullable(),
  disconnected: z.boolean(),
  config: z.unknown().optional(),
  latestVersion: z.string().max(32).optional(),
});
// The connection a request acts on, by the extension's own ID for it; without one, the first connection.
const connection = z.string().min(1).max(64).optional();
const server = { origin: z.string().max(2048).optional(), warned: z.literal(true).optional() };
export const requestSchema = z.discriminatedUnion('type', [
  // `check` fetches the account's settings. `reconnect` starts a connect flow for a connection whose tokens ended,
  // without the disclosure. `narrow` leaves all sites for added sites, keeping the connection. `update` asks Chrome for
  // the store's update (store builds only).
  z
    .object({
      type: z.enum([
        'status',
        'check',
        'capture',
        'disconnect',
        'clear',
        'pause',
        'resume',
        'reconnect',
        'narrow',
        'update',
      ]),
      connection,
    })
    .strict(),
  // `another` connects the organization the person acts in on the server's website, adding a connection unless that
  // organization is already connected, rather than connecting the given or first connection again. `origin` is that
  // server, the build's without one; `warned` says the person agreed to the warning a server outside the verified list
  // needs.
  z
    .object({
      type: z.literal('connect'),
      mode: captureModeSchema,
      connection,
      another: z.literal(true).optional(),
      ...server,
    })
    .strict(),
  // A click that needs Chrome's permission prompt: `prepare` records what it is for, and `finish` does it once
  // granted, from the popup or from the permission event if the prompt closed the popup.
  z
    .object({
      type: z.literal('prepare'),
      connect: captureModeSchema.optional(),
      sites: sitesSchema,
      connection,
      another: z.literal(true).optional(),
      ...server,
    })
    .strict(),
  z.object({ type: z.literal('finish') }).strict(),
  // How the extension treats a server before connecting to it (ServerResponse).
  z.object({ type: z.literal('server'), origin: z.string().max(2048) }).strict(),
  z.object({ type: z.literal('sites'), sites: sitesSchema, connection }).strict(),
  // The redirect page's address, which carries the authorization code (connected.html only).
  z.object({ type: z.literal('exchange'), url: z.string().max(4096) }).strict(),
]);
export type CaptureRequest = z.infer<typeof requestSchema>;
export type CaptureState = 'empty' | 'capturing' | 'complete' | 'interrupted' | 'revoked' | 'failed';
export interface CaptureStatus {
  state: CaptureState;
  completedAt?: string;
  cookieCount?: number;
}
// Extension-local record of the last upload. The digest is of the last capture the server accepted.
// `connect` marks uploads after Connect until one is accepted; it lifts a dashboard disconnect.
export const syncRecordSchema = z
  .object({
    state: z.enum([
      'never',
      'uploading',
      'synced',
      'unchanged',
      'unavailable',
      'failed',
      'delete_failed',
      'outdated',
      'too_large',
    ]),
    digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    connect: z.literal(true).optional(),
    uploadedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    cookieCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SyncRecord = z.infer<typeof syncRecordSchema>;
export type SyncState = SyncRecord['state'];
export type SyncStatus = Omit<SyncRecord, 'digest' | 'connect'>;
// POST /api/v1/captures success body. `latestVersion` is the extension build the server offers for download.
export const uploadResultSchema = z.object({
  status: z.enum(['stored', 'unchanged']),
  completedAt: z.iso.datetime({ offset: true }),
  cookieCount: z.number().int().nonnegative(),
  latestVersion: z.string().max(32).optional(),
  // The account's settings after this upload, so the extension catches up right away.
  settings: syncSettingsSchema.optional(),
});
// The extension names its build in this header on uploads; the server refuses builds older than it supports.
export const extensionVersionHeader = 'x-extension-version';
// Dotted numeric versions, as in the manifest. Missing or non-numeric parts count as 0.
export function compareVersions(a: string, b: string): number {
  const [left, right] = [a, b].map(version => version.split('.').map(part => Number.parseInt(part, 10) || 0));
  for (let index = 0; index < Math.max(left!.length, right!.length); index++) {
    const difference = (left![index] ?? 0) - (right![index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}
// The organization a sync request acts in, by its public ID. A request without it acts in the one the browser connected
// in, as builds from before accounts expect.
export const organizationHeader = 'x-organization';
// GET /api/v1/me success body, as the extension reads it. `organization` is the one a request without
// organizationHeader acts in, which servers from before organizations leave out. `organizations` is every one the
// person belongs to, and `defaultOrganization` the one the extension shows first (their personal one, where the
// server has them); servers from before accounts leave both out, and the extension then syncs to `organization` alone.
export const organizationSchema = z.object({ id: z.string().min(1).max(64), name: z.string().max(100) });
export type Organization = z.infer<typeof organizationSchema>;
export const meSchema = z.object({
  user: z.object({ id: z.string().min(1), email: z.string() }),
  organization: organizationSchema.nullish().catch(undefined),
  organizations: z.array(organizationSchema).max(100).optional().catch(undefined),
  defaultOrganization: z.string().min(1).max(64).nullish().catch(undefined),
});
// The account this browser syncs to. `reconnect`: connected, but its tokens ended (disconnected, unused for 30 days,
// or updated from a build that synced with the web sign-in), so sync waits for Reconnect.
export type AccountState =
  | { state: 'none' }
  | { state: 'syncing'; email: string }
  | { state: 'reconnect'; email?: string };
// One connection in the list the popup and the setup tab show: an organization on one server.
export interface ConnectionSummary {
  id: string;
  origin: string;
  // As the server last named it; unknown until it does.
  organization?: Organization;
  account: AccountState;
  settings: CaptureSettings;
}
// The status of one connection, with the list of every connection. Without any connection, `connection` is absent and
// the rest is a new connection's.
export interface StatusResponse {
  ok: true;
  connection?: string;
  // The connection's server origin, or the build's for a new one.
  origin: string;
  connections: ConnectionSummary[];
  capture: CaptureStatus;
  sync: SyncStatus;
  settings: CaptureSettings;
  account: AccountState;
  // A connect flow is waiting for the Clutchbox tab.
  connecting?: true;
  permissionGranted: boolean;
  // Sites the account lists that this browser has not granted, so they are not captured here.
  ungrantedSites: string[];
  config: ExtensionConfig;
  // A newer manual build the server offers, if any (manual builds only).
  update?: string;
  // Update now found no update in Chrome yet; Chrome installs it when the store has it.
  noUpdate?: true;
}
export type Response =
  | StatusResponse
  | {
      ok: false;
      error:
        | 'forbidden'
        | 'invalid_request'
        | 'permission_required'
        | 'excluded'
        | 'paused'
        | 'capture_failed'
        // The Clutchbox server could not be reached to change the account's settings.
        | 'unavailable'
        // The connection's tokens ended; Reconnect first.
        | 'reconnect'
        // A connect flow that expired, was already used, or that this extension did not start.
        | 'expired'
        // Connecting was canceled on the server's website.
        | 'denied'
        // A server outside the verified list, without agreeing to its warning.
        | 'unverified_server';
    };
// How the extension treats a server before connecting to it: its own build's, one it is already connected to, one on
// the verified list (with the list's name for it), one the browser's administrator approved, or else one that needs
// the warning first.
export type ServerTrust = 'build' | 'connected' | 'verified' | 'policy' | 'unverified';
export interface ServerResponse {
  ok: true;
  origin: string;
  trust: ServerTrust;
  name?: string;
}
// The answer to `exchange`, for connected.html only: never a status, and never carries tokens.
export interface ExchangeResponse {
  ok: true;
  email: string;
  organization?: string;
  // The tab the connect click came from, to return to.
  opener?: number;
}
export * from './oauth';
export * from './servers';
export * from './sites';
export * from './sync';
