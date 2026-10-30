import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { databaseSchema } from '@clutchbox/server/database-schema';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuth } from '../../server/src/auth';
import type { ServerConfig } from '../../server/src/config';
import type { Database } from '../../server/src/database';
import * as schema from '../../server/src/schema';
import { type ClientAddress, nodeServer } from './node-upgrade';

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
// Each request's headers as the routes get them.
let seen: IncomingMessage['headers'][] = [];
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
async function listen(options?: ClientAddress) {
  seen = [];
  const db = drizzle(pg, { schema: databaseSchema }) as unknown as Database;
  await db.insert(schema.installation).values({ dataClass: 'nonproduction' });
  const auth = createAuth(db, config);
  const listener = async (request: IncomingMessage, response: ServerResponse) => {
    seen.push({ ...request.headers });
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
async function signInStatuses(
  port: number,
  count: number,
  headers: (i: number) => Record<string, string> = () => ({}),
) {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-forwarded-for': `198.51.100.${i + 1}`,
        ...headers(i),
      },
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

  it("keys on the platform's client header, not on X-Forwarded-For", async () => {
    const port = await listen({ clientIpHeader: 'fly-client-ip' });
    // A new X-Forwarded-For each time, from one client as the platform saw it: limited.
    const one = await signInStatuses(port, 11, () => ({ 'fly-client-ip': '203.0.113.7' }));
    expect(one[10]).toBe(429);
    // Eleven clients as the platform saw them: none limited.
    const many = await signInStatuses(port, 11, i => ({ 'fly-client-ip': `203.0.113.${100 + i}` }));
    expect(many).toEqual(Array(11).fill(200));
  });

  it("trusts a forwarder's X-Forwarded-For only with the secret, and keeps the secret from the routes", async () => {
    const forwardedSecret = randomBytes(32).toString('base64url');
    const port = await listen({ clientIpHeader: 'fly-client-ip', forwardedSecret });
    // From the forwarder, which the platform sees as one client, for eleven clients it names first: none limited.
    const forwarded = await signInStatuses(port, 11, i => ({
      'x-forwarded-for': `198.51.100.${i + 1}, 192.0.2.1`,
      'x-forwarded-secret': forwardedSecret,
      'fly-client-ip': '192.0.2.1',
    }));
    expect(forwarded).toEqual(Array(11).fill(200));
    // A wrong secret is a direct client's request: keyed on the platform's header, and limited.
    const guessed = await signInStatuses(port, 11, () => ({
      'x-forwarded-secret': 'a'.repeat(forwardedSecret.length),
      'fly-client-ip': '203.0.113.9',
    }));
    expect(guessed[10]).toBe(429);
    expect(seen.every(headers => headers['x-forwarded-secret'] === undefined)).toBe(true);
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
