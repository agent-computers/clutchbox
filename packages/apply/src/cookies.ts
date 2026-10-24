import { type CapturedCookie, siteOfCookie } from '@agent-computers/capture';

// A cookie's identity, as the browser keys it: setting a cookie with the same identity replaces it.
const cookieKey = (cookie: CapturedCookie) =>
  JSON.stringify([
    cookie.storeId,
    cookie.partitionKey?.topLevelSite ?? null,
    cookie.partitionKey?.hasCrossSiteAncestor ?? null,
    cookie.hostOnly,
    cookie.domain.toLowerCase(),
    cookie.path,
    cookie.name,
  ]);
// Expiry counts at day granularity, as in captureDigest: per-request rolls are not changes.
const cookieState = (cookie: CapturedCookie) =>
  JSON.stringify([
    cookie.value,
    cookie.secure,
    cookie.httpOnly,
    cookie.sameSite,
    cookie.session,
    cookie.expirationDate === undefined ? null : Math.floor(cookie.expirationDate / 86_400),
  ]);
const sortedSites = (cookies: CapturedCookie[]) => [...new Set(cookies.map(siteOfCookie))].sort();
export type CookieChanges = {
  // Cookies to set: added or changed on the host since the baseline.
  set: CapturedCookie[];
  // Baseline cookies gone from a site the capture still holds: deleted on the computer.
  remove: CapturedCookie[];
  // Sites with no cookie in the capture any more (signed out locally): every cookie on them is cleared.
  clearSites: string[];
  // Sites where a cookie was added or removed, not only rotated: what the pending notice names.
  addedOrRemovedSites: string[];
};
// What an apply changes on a computer, given the capture it last applied (the baseline). The host wins
// a cookie it changed; cookies it did not change keep the computer's value; sites only touched on the
// computer are never named. Without a baseline, every target site is replaced wholesale. A baseline cookie
// that expired by `asOf` (the next capture's completedAt) left the host's capture by timing out, not by a
// deletion: the computer keeps its copy, which it may have refreshed, and a site whose cookies all
// expired is not cleared.
export function cookieChanges(
  baseline: CapturedCookie[] | null,
  next: CapturedCookie[],
  syncedSites: string[],
  asOf: string,
): CookieChanges {
  const nextSites = sortedSites(next);
  if (!baseline) {
    const clearSites = [...new Set([...syncedSites, ...nextSites])].sort();
    return { set: next, remove: [], clearSites, addedOrRemovedSites: clearSites };
  }
  const asOfSeconds = Date.parse(asOf) / 1000;
  const lapsed = (cookie: CapturedCookie) =>
    cookie.expirationDate !== undefined && cookie.expirationDate <= asOfSeconds;
  const live = baseline.filter(cookie => !lapsed(cookie));
  const liveSites = new Set(live.map(siteOfCookie));
  const lapsedSites = new Set(
    baseline
      .filter(lapsed)
      .map(siteOfCookie)
      .filter(site => !liveSites.has(site)),
  );
  const before = new Map(live.map(cookie => [cookieKey(cookie), cookie]));
  const after = new Map(next.map(cookie => [cookieKey(cookie), cookie]));
  const held = new Set(nextSites);
  const touched = new Set<string>();
  const set = [...after].flatMap(([key, cookie]) => {
    const old = before.get(key);
    if (!old) touched.add(siteOfCookie(cookie));
    return !old || cookieState(old) !== cookieState(cookie) ? [cookie] : [];
  });
  const gone = [...before].filter(([key]) => !after.has(key)).map(([, cookie]) => cookie);
  for (const cookie of gone) touched.add(siteOfCookie(cookie));
  const clearSites = [...new Set([...liveSites, ...syncedSites])]
    .filter(site => !held.has(site) && !lapsedSites.has(site))
    .sort();
  return {
    set,
    remove: gone.filter(cookie => held.has(siteOfCookie(cookie))),
    clearSites,
    addedOrRemovedSites: [...new Set([...touched, ...clearSites])].sort(),
  };
}

// Chrome DevTools Protocol Network.CookieParam, as accepted by Storage.setCookies.
export type CdpCookieParam = {
  name: string;
  value: string;
  url?: string | undefined;
  domain?: string | undefined;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'None' | 'Lax' | 'Strict' | undefined;
  expires?: number | undefined;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean } | undefined;
};
const sameSite = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: undefined } as const;
export function toCdpCookie(cookie: CapturedCookie): CdpCookieParam {
  const param: CdpCookieParam = {
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  };
  // A domain attribute would widen a host-only cookie to subdomains; a URL keeps it host-only.
  if (cookie.hostOnly) param.url = `${cookie.secure ? 'https' : 'http'}://${cookie.domain}${cookie.path}`;
  else param.domain = cookie.domain;
  if (sameSite[cookie.sameSite]) param.sameSite = sameSite[cookie.sameSite];
  if (!cookie.session && cookie.expirationDate !== undefined) param.expires = cookie.expirationDate;
  if (cookie.partitionKey)
    param.partitionKey = {
      topLevelSite: cookie.partitionKey.topLevelSite,
      hasCrossSiteAncestor: cookie.partitionKey.hasCrossSiteAncestor,
    };
  return param;
}
// Setting an already-expired copy deletes the matching cookie, partition included.
export const expiredCdpCookie = (cookie: CapturedCookie): CdpCookieParam => ({
  ...toCdpCookie(cookie),
  value: '',
  expires: 1,
});
