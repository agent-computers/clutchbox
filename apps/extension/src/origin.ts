// The only server the extension talks to. Builds override it with WXT_SERVER_ORIGIN.
export const defaultServerOrigin = 'https://www.agent-computers.com';
export function serverOriginOf(value: string | undefined): string {
  const url = new URL(value || defaultServerOrigin);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')
    throw new Error('Server origin must use HTTPS');
  return url.origin;
}
