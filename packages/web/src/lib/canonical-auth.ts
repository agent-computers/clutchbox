// Browser auth, and / which routes on the session cookie, must run on the configured
// origin so its cookies and CSRF origin agree. Do not redirect API POSTs or rewrite
// signed OAuth query parameters.
export function canonicalAuthUrl(requestUrl: string, environment: string | undefined, authOrigin: string | undefined) {
  if (environment !== 'production' || !authOrigin) return null;
  const source = new URL(requestUrl);
  const target = new URL(authOrigin);
  if (source.origin === target.origin) return null;
  target.pathname = source.pathname;
  target.search = source.search;
  return target;
}
