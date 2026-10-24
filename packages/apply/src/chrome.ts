import { siteOfHost } from '@agent-computers/capture';
import type { CdpCookieParam } from './cookies';

// Sends one Chrome DevTools Protocol command and resolves with its result, rejecting on a protocol error, as
// Playwright's and Puppeteer's CDP sessions do.
export type CdpSend = (method: string, params: Record<string, unknown>) => Promise<unknown>;

// Chrome DevTools Protocol Network.Cookie, as Storage.getCookies returns it.
export type CdpCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  sameSite?: 'None' | 'Lax' | 'Strict' | undefined;
  priority?: string | undefined;
  partitionKey?: string | { topLevelSite: string; hasCrossSiteAncestor: boolean } | undefined;
};

// A cookie Chrome holds, as the CookieParam that sets it again. A host-only cookie (no leading dot) is set by URL,
// since a domain attribute would widen it to subdomains.
export function cookieParamOf(cookie: CdpCookie): CdpCookieParam & { priority?: string | undefined } {
  const param: CdpCookieParam & { priority?: string | undefined } = {
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  };
  if (cookie.domain.startsWith('.')) param.domain = cookie.domain;
  else param.url = `${cookie.secure ? 'https://' : 'http://'}${cookie.domain}${cookie.path}`;
  if (cookie.sameSite) param.sameSite = cookie.sameSite;
  if (!cookie.session && cookie.expires > 0) param.expires = cookie.expires;
  if (cookie.priority) param.priority = cookie.priority;
  if (cookie.partitionKey)
    param.partitionKey =
      typeof cookie.partitionKey === 'string'
        ? { topLevelSite: cookie.partitionKey, hasCrossSiteAncestor: false }
        : cookie.partitionKey;
  return param;
}

// Splits Chrome's cookies into those of clearSites and a count of the rest.
export function partitionCookies<C extends { domain: string }>(cookies: C[], clearSites: string[]) {
  const clear = new Set(clearSites);
  return {
    kept: cookies.filter(cookie => !clear.has(siteOfHost(cookie.domain))).length,
    clear: cookies.filter(cookie => clear.has(siteOfHost(cookie.domain))),
  };
}

const CHUNK = 500;
// Sets cookies in chunks; a rejected chunk is retried cookie by cookie, so one bad cookie costs only itself.
async function setCookies(send: CdpSend, cookies: CdpCookieParam[], context: { browserContextId?: string }) {
  let ok = 0;
  for (let i = 0; i < cookies.length; i += CHUNK) {
    const chunk = cookies.slice(i, i + CHUNK);
    try {
      await send('Storage.setCookies', { cookies: chunk, ...context });
      ok += chunk.length;
      continue;
    } catch {}
    for (const cookie of chunk) {
      try {
        await send('Storage.setCookies', { cookies: [cookie], ...context });
        ok++;
      } catch {}
    }
  }
  return ok;
}

// Applies a sync to a running Chrome: deletes every cookie of clearSites, then sets `cookies` (an expired one deletes
// its match, partition included). Other sites' cookies are never touched, so a run cut short only affects sites the
// next apply rewrites. Works over any CDP connection to the browser: a local Playwright or Puppeteer session, or a
// helper inside a remote computer. Storage commands act on the default browser context unless told otherwise, so
// pass browserContextId to apply to another one (each Playwright context is its own).
export async function applyCookies(
  send: CdpSend,
  {
    clearSites,
    cookies,
    browserContextId,
  }: { clearSites: string[]; cookies: CdpCookieParam[]; browserContextId?: string | undefined },
) {
  const context = browserContextId ? { browserContextId } : {};
  const { cookies: held } = (await send('Storage.getCookies', context)) as { cookies: CdpCookie[] };
  const { kept, clear } = partitionCookies(held, clearSites);
  const cleared = await setCookies(
    send,
    clear.map(cookie => ({ ...cookieParamOf(cookie), value: '', expires: 1 })),
    context,
  );
  const set = await setCookies(send, cookies, context);
  return { kept, cleared, set, failed: clear.length + cookies.length - cleared - set };
}
