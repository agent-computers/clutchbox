import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { databaseSchema } from '@agent-computers/server/database-schema';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuth } from '../../server/src/auth';
import type { ServerConfig } from '../../server/src/config';
import type { Database } from '../../server/src/database';
import * as schema from '../../server/src/schema';
import { nodeServer } from './node-upgrade';

// The web app's Node server in front of real Better Auth on PGlite: its rate limits must key on the client, not on
// an X-Forwarded-For the client chose. The WebSocket path is tested end to end in live-view.test.ts.
const origin = 'http://localhost:3098';
const config: ServerConfig = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/synthetic',
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'synthetic-only',
};
let template: PGlite;
let pg: PGlite;
let server: Server | undefined;
beforeAll(async () => {
  template = new PGlite();
  await migrate(drizzle(template, { schema: databaseSchema }), {
    migrationsFolder: fileURLToPath(new URL('../../server/migrations', import.meta.url)),
  });
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
});
afterEach(async () => {
  await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
  await pg.close();
});

// Better Auth's handler, as the framework runs it: a Node request in, its Response written out.
async function listen(options?: { trustProxy?: boolean }) {
  const db = drizzle(pg, { schema: databaseSchema }) as unknown as Database;
  await db.insert(schema.installation).values({ dataClass: 'nonproduction' });
  const auth = createAuth(db, config);
  const listener = async (request: IncomingMessage, response: ServerResponse) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (typeof value === 'string') headers.set(name, value);
    // The tests only POST.
    const body = Buffer.concat(await request.toArray());
    const answer = await auth.handler(new Request(`${origin}${request.url}`, { method: 'POST', headers, body }));
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(Buffer.from(await answer.arrayBuffer()));
  };
  server = nodeServer(listener, options);
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

// Sign-in starts, each from a new X-Forwarded-For; the route allows 10 a minute per client.
async function signInStatuses(port: number, count: number) {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i + 1}` },
      body: JSON.stringify({ provider: 'google', callbackURL: '/app' }),
    });
    statuses.push(response.status);
  }
  return statuses;
}

describe('node server', () => {
  it('rate-limits a client that sends a new X-Forwarded-For on every request', async () => {
    const statuses = await signInStatuses(await listen(), 11);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
  });

  it('keeps the X-Forwarded-For a trusted proxy sets', async () => {
    expect(await signInStatuses(await listen({ trustProxy: true }), 11)).toEqual(Array(11).fill(200));
  });

  it('closes an upgrade to anything but WebSocket without leaving it open', async () => {
    const socket = connect(await listen(), '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: h2c\r\nConnection: Upgrade, HTTP2-Settings\r\n\r\n');
    await new Promise(resolve => socket.once('close', resolve));
    expect(chunks).toEqual([]);
  });
});
