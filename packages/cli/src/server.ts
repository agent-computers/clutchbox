import { serverProofPath } from '@clutchbox/capture';

// The server's origin from --server. Only an origin goes on, so a path, query, or anything a shell would interpret
// never reaches the commands built from it. Plain HTTP only for this machine, as in local development.
export function serverOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`--server must be a URL, such as https://clutchbox.example.com (got ${input})`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new Error(`--server must use https (got ${input})`);
  if (url.username || url.password) throw new Error('--server must not contain a username or password');
  return url.origin;
}

// Where the server's API answers, from its well-known document: its own origin, unless the API runs apart from the web
// app. A missing, slow, or malformed answer falls back to the server's origin, as servers before the document named it.
export async function apiOriginOf(origin: string, fetchDocument: typeof fetch = fetch): Promise<string> {
  try {
    const response = await fetchDocument(`${origin}${serverProofPath}`, { signal: AbortSignal.timeout(5000) });
    const { api } = (await response.json()) as { api?: unknown };
    return typeof api === 'string' ? serverOrigin(api) : origin;
  } catch {
    return origin;
  }
}
