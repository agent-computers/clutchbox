import { z } from 'zod';
import builtIn from '../verified-servers.json' with { type: 'json' };

// Servers other than the extension's own build server. Connecting to one shows a warning first, since that server, and
// whoever runs it, receives the sign-ins the connection syncs, unless it is on the verified list or the browser's
// administrator approved it (Chrome Enterprise policy, `approvedServers`).

// A server's origin: HTTPS, or HTTP on this machine for development.
export function serverOriginOfInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  if (url.username || url.password || (!loopback && !url.hostname.includes('.'))) return null;
  return url.origin;
}

// The verified list: `verified-servers.json` in this package, changed by pull request. Each entry's server proves it
// runs at its origin with the file at serverProofPath, which CI checks. Our server serves the list at
// verifiedServersPath, and the extension falls back to the copy it was built with.
export const verifiedServerSchema = z
  .object({
    origin: z.string().refine(value => serverOriginOfInput(value) === value && value.startsWith('https://'), {
      message: 'an HTTPS origin, such as https://agents.example.com',
    }),
    name: z.string().trim().min(1).max(100),
  })
  .strict();
export type VerifiedServer = z.infer<typeof verifiedServerSchema>;
export const verifiedServersSchema = z.object({ servers: z.array(verifiedServerSchema).max(1000) });
export const builtInVerifiedServers: VerifiedServer[] = verifiedServersSchema.parse(builtIn).servers;
export const verifiedServersPath = '/api/v1/verified-servers';
// Every server serves this, naming its own origin.
export const serverProofPath = '/.well-known/agent-computers.json';
export const serverProofSchema = z.object({ origin: z.string() });
