import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { serverProofPath, serverProofSchema, verifiedServersSchema } from '../packages/capture/src/servers';

// Checks the verified list (packages/capture/verified-servers.json): well-formed, sorted by origin, one entry per
// origin, and each server proving it runs at its origin with the file at serverProofPath, served there without a
// redirect.
const file = path.join(import.meta.dirname, '../packages/capture/verified-servers.json');
const { servers } = verifiedServersSchema.parse(JSON.parse(await readFile(file, 'utf8')));
const failures: string[] = [];
const origins = servers.map(server => server.origin);
if (origins.join('\n') !== [...origins].sort().join('\n')) failures.push('Entries must be sorted by origin.');
if (new Set(origins).size !== origins.length) failures.push('Each origin must be listed once.');
await Promise.all(
  servers.map(async ({ origin }) => {
    const url = `${origin}${serverProofPath}`;
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const proof = serverProofSchema.safeParse(await response.json().catch(() => undefined));
      if (!response.ok) failures.push(`${url} answered ${response.status}.`);
      else if (!proof.success || proof.data.origin !== origin)
        failures.push(`${url} must be JSON naming its origin: {"origin": "${origin}"}.`);
    } catch (error) {
      failures.push(`${url} could not be fetched (${error instanceof Error ? error.message : 'unknown error'}).`);
    }
  }),
);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`PASS: ${servers.length} verified ${servers.length === 1 ? 'server' : 'servers'}.`);
