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
