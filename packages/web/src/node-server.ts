import { createServer } from 'node:http';
import { clientAddressFromEnv, listenUntilStopped, nodeServer } from '@clutchbox/api/node-upgrade';
import { SHUTDOWN_GRACE_MS } from '@clutchbox/server/computer-timing';
import next from 'next';

// An app's production server off Vercel (self-hosted, or `bun run start` locally): Next.js's own request handling,
// plus the WebSocket upgrades its server drops, which the live-view relay needs. Vercel runs the app with its own
// runtime and never loads this. The app's server.ts calls it after `next build`, as `node --import tsx server.ts`,
// with its directory and its migration. HOST and PORT choose the address; MIGRATE_ON_START=true applies pending
// migrations first (the migration takes a lock, so replicas starting together are safe); TRUST_PROXY,
// CLIENT_IP_HEADER, and FORWARDED_SECRET say where the client's address comes from (ClientAddress in
// @clutchbox/api/node-upgrade).
export async function startNodeServer({ dir, migrate }: { dir: string; migrate: () => Promise<boolean> }) {
  if (process.env.MIGRATE_ON_START === 'true' && !(await migrate())) process.exit(1);
  const hostname = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 3000);
  // Next.js attaches its own upgrade handling, which ends the socket of any upgrade to an app route, to the server its
  // first request arrives on unless given another: this stand-in, which never listens or gets an upgrade, keeps it off
  // the real one.
  const app = next({ dev: false, dir, hostname, port, httpServer: createServer() });
  await app.prepare();
  const server = nodeServer(app.getRequestHandler(), clientAddressFromEnv());
  // A host's stop or a deploy: relays close with their reconnect code and requests in flight finish, for at most
  // SHUTDOWN_GRACE_MS.
  listenUntilStopped(server, { hostname, port, graceMs: SHUTDOWN_GRACE_MS });
}
