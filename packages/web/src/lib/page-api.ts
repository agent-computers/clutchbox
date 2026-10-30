import 'server-only';
import type { SignInMethods } from '@clutchbox/server/config';
import { headers } from 'next/headers';

// How a server-rendered page reaches the API: a GET to an /api/v1 path, answered by the deployment's own API in this
// process, or by a separate API server over HTTP. Each app's deployment/server.ts passes one to its pages, which read
// the session, config, and database only through it.
export type PageApi = (path: string, init: { headers: Headers }) => Promise<Response>;

// A GET as the visitor, with their cookies, so the API sees their session: the body, or the status of a failure.
export async function apiGet<T>(
  api: PageApi,
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  const forwarded = new Headers();
  const cookie = (await headers()).get('cookie');
  if (cookie) forwarded.set('cookie', cookie);
  const response = await api(`/api/v1${path}`, { headers: forwarded });
  if (response.ok) return { ok: true, data: (await response.json()) as T };
  // An answer the page has no branch for is the API's failure, which the page's error boundary shows.
  if (![400, 401, 403, 404].includes(response.status)) throw new Error(`API ${path.split('?')[0]}: ${response.status}`);
  return { ok: false, status: response.status };
}
// A GET the page can't do without.
export async function apiData<T>(api: PageApi, path: string): Promise<T> {
  const result = await apiGet<T>(api, path);
  if (!result.ok) throw new Error(`API ${path.split('?')[0]}: ${result.status}`);
  return result.data;
}

// What the pages read: /me, the person and the organization they act in (null before they join one).
export type Me = {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string } | null;
  organizations: { id: string; name: string }[];
};
export type { SignInMethods };
export type ConsentRequest = {
  client: { name: string | null; logo: string | null; policy: string | null; terms: string | null };
  connect: { scope: string; organization: string } | null;
};
