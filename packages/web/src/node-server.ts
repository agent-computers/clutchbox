import { createServer } from 'node:http';
import { nodeServer } from '@agent-computers/api/node-upgrade';
import next from 'next';

// An app's production server off Vercel (self-hosted, or `bun run start` locally): Next.js's own request handling,
// plus the WebSocket upgrades its server drops, which the live-view relay needs. Vercel runs the app with its own
// runtime and never loads this. The app's server.ts calls it after `next build`, as `node --import tsx server.ts`,
// with its directory and its migration. HOST and PORT choose the address; MIGRATE_ON_START=true applies pending
// migrations first (the migration takes a lock, so replicas starting together are safe); TRUST_PROXY=true keeps the
// X-Forwarded-For a reverse proxy in front sets, which it must overwrite rather than append to.
export async function startNodeServer({ dir, migrate }: { dir: string; migrate: () => Promise<boolean> }) {
  if (process.env.MIGRATE_ON_START === 'true' && !(await migrate())) process.exit(1);
  const hostname = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 3000);
  // Next.js attaches its own upgrade handling, which ends the socket of any upgrade to an app route, to the server its
  // first request arrives on unless given another: this stand-in, which never listens or gets an upgrade, keeps it off
  // the real one.
  const app = next({ dev: false, dir, hostname, port, httpServer: createServer() });
  await app.prepare();
  const server = nodeServer(app.getRequestHandler(), { trustProxy: process.env.TRUST_PROXY === 'true' });
  server.listen(port, hostname, () => console.log(`Listening on http://${hostname}:${port}`));
  // As the container's first process, Node gets no default handling of these signals.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => process.exit(0));
}
