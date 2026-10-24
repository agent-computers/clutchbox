import type { CapturedCookie } from './index';

// Shared by the extension (skip unchanged uploads), the server (authoritative
// change detection), and sync apply (per-site precedence). Keep them in step.

// Approximate registrable domain; the prototype has no public-suffix list.
export function siteOfHost(hostname: string): string {
  const labels = hostname.replace(/^\./, '').replace(/\.$/, '').toLowerCase().split('.');
  const secondLevel =
    labels.length > 2 && /^(co|com|org|net|ac|gov|edu)$/.test(labels.at(-2)!) && labels.at(-1)!.length === 2;
  return labels.slice(secondLevel ? -3 : -2).join('.');
}
export const siteOfUrl = (url: string) => siteOfHost(new URL(url).hostname);
export const siteOfCookie = (cookie: Pick<CapturedCookie, 'domain'>) => siteOfHost(cookie.domain);

type DigestCookie = Pick<
  CapturedCookie,
  'domain' | 'hostOnly' | 'path' | 'name' | 'value' | 'expirationDate' | 'partitionKey'
>;
type DigestScope = { mode: 'whole-browser' } | { mode: 'sites'; sites: string[] };
// Expiry counts at day granularity: refreshed lifetimes sync, per-request rolls do not.
// The scope form is for the extension's local skip check only; the server stores the cookie-only digest.
// Exclusions never count: they only remove cookies, which the cookie rows already reflect.
export async function captureDigest(cookies: DigestCookie[], scope?: DigestScope): Promise<string> {
  const rows = cookies
    .map(cookie =>
      JSON.stringify([
        cookie.domain.toLowerCase(),
        cookie.hostOnly,
        cookie.path,
        cookie.name,
        cookie.value,
        cookie.expirationDate === undefined ? null : Math.floor(cookie.expirationDate / 86_400),
        cookie.partitionKey?.topLevelSite ?? null,
        cookie.partitionKey?.hasCrossSiteAncestor ?? null,
      ]),
    )
    .sort();
  if (scope) rows.push(JSON.stringify([scope.mode, scope.mode === 'sites' ? [...scope.sites].sort() : []]));
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rows.join('\n')));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
