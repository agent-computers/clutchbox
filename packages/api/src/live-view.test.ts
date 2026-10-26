import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { databaseSchema } from '@agent-computers/server/database-schema';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createAuth } from '../../server/src/auth';
import type { ComputerProvider } from '../../server/src/computers';
import { openComputerSession, takeOverComputer } from '../../server/src/computers';
import type { ServerConfig } from '../../server/src/config';
import type { Database } from '../../server/src/database';
import { fakeComputerProvider } from '../../server/src/fake-computer-provider';
import { heartbeat } from '../../server/src/heartbeat';
import { noMetering } from '../../server/src/hooks';
import { inTheOrganization } from '../../server/src/member-fixtures';
import { currentMember } from '../../server/src/organizations';
import * as schema from '../../server/src/schema';
import { liveViewHandler } from './live-view';
import { nodeServer } from './node-upgrade';

// The live-view relay route, in process: every refusal before the upgrade, against PGlite and real Better Auth, and
// connections end to end through Vercel's upgrade and the Node server's, with a WebSocket server standing in for the
// computer's websockify. The relay's filtering is tested in packages/server.
const origin = 'http://localhost:3099';
const config: ServerConfig = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/synthetic',
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'synthetic-only',
};
let pg: PGlite;
let db: Database;
let auth: ReturnType<typeof createAuth>;
let fake: ReturnType<typeof fakeComputerProvider>;
async function identity(id: string) {
  const person = { id, name: `Fixture ${id}`, email: `${id}@example.test` };
  await db.insert(schema.user).values({ ...person, emailVerified: true });
  // Into the deployment's organization, as sign-up does.
  await inTheOrganization(db, person);
  const token = randomBytes(32).toString('base64url');
  await db
    .insert(schema.session)
    .values({ id: randomUUID(), userId: id, token, expiresAt: new Date(Date.now() + 3600_000) });
  const signature = createHmac('sha256', config.BETTER_AUTH_SECRET).update(token).digest('base64');
  return `${(await auth.$context).authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
}
// A visible heartbeat: the page load's live watch, which the relay needs.
const watch = async (userId: string, lease: string) =>
  heartbeat(db, { provider: fake.provider, metering: noMetering }, await member(userId), {
    leases: [{ kind: 'live-view', id: lease, state: 'visible' }],
  });
const open = async (userId: string) =>
  openComputerSession(
    db,
    { provider: fake.provider, metering: noMetering },
    { ...(await member(userId)), clientId: 'agent-client' },
  );

// The member a person acts as, which the routes resolve from the session.
const member = async (userId: string) => (await currentMember(db, userId))!;
let template: PGlite;
beforeAll(async () => {
  template = new PGlite();
  await migrate(drizzle(template, { schema: databaseSchema }), {
    migrationsFolder: fileURLToPath(new URL('../../server/migrations', import.meta.url)),
  });
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  db = drizzle(pg, { schema: databaseSchema }) as unknown as Database;
  await db.insert(schema.installation).values({ dataClass: 'nonproduction' });
  auth = createAuth(db, config);
  await auth.$context;
  fake = fakeComputerProvider();
  await db.insert(schema.oauthClient).values({ id: 'agent-client', clientId: 'agent-client', redirectUris: [] });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await pg.close();
});

describe('live view relay route', () => {
  it('refuses before upgrading without a session, from another origin, without a watched lease, or when the computer is unreachable', async () => {
    const upgrade = vi.fn(async () => new Response(null, { status: 204 }));
    const handler = (computers: ComputerProvider = fake.provider) =>
      liveViewHandler({ db, auth, origin, computers, upgrade });
    const a = await identity('a');
    const b = await identity('b');
    const page = randomUUID();
    const connect = async (
      lease: string | null,
      { cookie, from = origin, websocket = true }: { cookie?: string; from?: string | null; websocket?: boolean },
      computers?: ComputerProvider,
    ) => {
      const response = await handler(computers)(
        new Request(`${origin}/api/v1/live-view${lease === null ? '' : `?lease=${lease}`}`, {
          headers: {
            ...(cookie ? { cookie } : {}),
            ...(from ? { origin: from } : {}),
            ...(websocket ? { upgrade: 'websocket', connection: 'Upgrade' } : {}),
          },
        }),
      );
      return { status: response.status, json: await response.json() };
    };
    expect(await connect(page, {})).toEqual({ status: 401, json: { error: 'unauthenticated' } });
    for (const from of ['https://evil.test', `${origin}.evil.test`, null])
      expect(await connect(page, { cookie: a, from }), String(from)).toEqual({
        status: 403,
        json: { error: 'forbidden_origin' },
      });
    for (const lease of [null, '', 'not-a-uuid', `${page}x`])
      expect((await connect(lease, { cookie: a })).status, String(lease)).toBe(400);
    expect((await connect(page, { cookie: a, websocket: false })).status).toBe(426);
    // No computer yet.
    expect(await connect(page, { cookie: a })).toEqual({ status: 404, json: { error: 'not_found' } });
    // A computer, but this page load holds no watch on it; another user's watch on the same lease ID does not count.
    await open('a');
    await open('b');
    await watch('b', page);
    expect(await connect(page, { cookie: a })).toEqual({ status: 409, json: { error: 'not_watching' } });
    expect(upgrade).not.toHaveBeenCalled();
    // Watched, but the computer cannot be reached: logged by class only, never the stream's URL or token.
    await watch('a', page);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const down = { ...fake.provider, connect: async () => Promise.reject(new Error('sandbox-1 token-sandbox-1')) };
    expect(await connect(page, { cookie: a }, down)).toEqual({ status: 503, json: { error: 'service_unavailable' } });
    // The stream's WebSocket refuses the connection.
    fake.setStreamUrl('ws://127.0.0.1:1/');
    expect(await connect(page, { cookie: a })).toEqual({ status: 503, json: { error: 'service_unavailable' } });
    expect(fake.calls.streams).toEqual(['sandbox-1']);
    expect(logged.mock.calls.flat().join(' ')).not.toMatch(/token|127\.0\.0\.1/);
    expect(upgrade).not.toHaveBeenCalled();
    // A lapsed watch no longer connects.
    vi.useFakeTimers({ now: Date.now() + 10 * 60_000, toFake: ['Date'] });
    try {
      expect((await connect(page, { cookie: a })).status).toBe(409);
    } finally {
      vi.useRealTimers();
    }
    expect((await connect(page, { cookie: b })).status).toBe(503);
  });

  // Both ways the route gets its socket: Vercel's runtime, which hands upgradeWebSocket the raw request through its
  // request context as `vc dev` does, and the web app's Node server (node-upgrade.ts), which runs the handshake
  // through the framework's request listener.
  describe.each(['vercel', 'node'] as const)('end to end through %s', runtime => {
    let computer: WebSocketServer;
    let server: Server;
    const upstreamRequests: IncomingMessage[] = [];
    const received: Buffer[] = [];
    const responses: Response[] = [];
    beforeEach(async () => {
      upstreamRequests.length = 0;
      received.length = 0;
      responses.length = 0;
      // The computer's websockify: greets with the RFB version and records what reaches it.
      computer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      computer.on('connection', (socket, request) => {
        upstreamRequests.push(request);
        socket.on('message', data => received.push(data as Buffer));
        socket.send(Buffer.from('RFB 003.008\n'));
      });
      await new Promise(resolve => computer.once('listening', resolve));
      fake.setStreamUrl(`ws://127.0.0.1:${(computer.address() as AddressInfo).port}/`);
      const handler = liveViewHandler({ db, auth, origin, computers: fake.provider });
      const toRequest = (request: IncomingMessage) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers))
          if (typeof value === 'string') headers.set(name, value);
        return new Request(`${origin}${request.url}`, { headers });
      };
      if (runtime === 'vercel') {
        server = createServer((_request, response) => response.writeHead(404).end());
        server.on('upgrade', (request, socket, head) => {
          (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] = {
            get: () => ({ upgradeWebSocket: () => ({ req: request, socket, head }) }),
          };
          void handler(toRequest(request)).then(response => {
            responses.push(response);
            if (response.status !== 204) socket.end(`HTTP/1.1 ${response.status} Refused\r\n\r\n`);
          });
        });
      } else {
        // The framework's request listener, as Next.js runs the route: a Node request in, its Response written out.
        const listener = async (request: IncomingMessage, response: ServerResponse) => {
          // Only the route: other requests to the port (a local port scanner's) get a 404 and no record.
          if (!request.url?.startsWith('/api/v1/live-view')) return void response.writeHead(404).end();
          const answer = await handler(toRequest(request));
          responses.push(answer);
          response.writeHead(answer.status, Object.fromEntries(answer.headers));
          response.end(Buffer.from(await answer.arrayBuffer()));
        };
        server = nodeServer(listener);
      }
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    });
    afterEach(async () => {
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')];
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => computer.close(resolve));
    });
    const until = async (check: () => boolean, action?: () => void) => {
      for (let i = 0; i < 100 && !check(); i++) {
        action?.();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(check()).toBe(true);
    };
    const sent = () => Buffer.concat(received);

    it('relays the screen to a watcher, passes input only during a takeover, and releases held keys on close', async () => {
      const a = await identity('a');
      const page = randomUUID();
      await open('a');
      await watch('a', page);
      const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/live-view?lease=${page}`;
      const browser = new WebSocket(url, 'binary', { headers: { cookie: a }, origin });
      const greeting = await new Promise<Buffer>((resolve, reject) => {
        browser.once('message', data => resolve(data as Buffer));
        browser.once('error', reject);
      });
      expect(greeting.toString()).toBe('RFB 003.008\n');
      expect(browser.protocol).toBe('binary');
      // The computer got the provider's traffic token, which never went to the browser.
      expect(upstreamRequests[0]?.headers['e2b-traffic-access-token']).toBe('token-sandbox-1');
      expect(upstreamRequests[0]?.headers['sec-websocket-protocol']).toBe('binary');
      // With the Origin the computer's websockify accepts, which no page in the computer's Chrome can send.
      expect(upstreamRequests[0]?.headers.origin).toBe('agent-computers-relay');
      // Handshake, a key press while only watching, then a framebuffer request: only the handshake and the request
      // arrive, in order.
      const keyDown = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);
      const update = Buffer.from([3, 0, 0, 0, 0, 0, 5, 0, 3, 32]);
      for (const message of [Buffer.from('RFB 003.008\n'), Buffer.from([1]), Buffer.from([1]), keyDown, update])
        browser.send(message);
      const handshake = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]);
      await until(() => sent().length >= handshake.length + update.length);
      expect(sent()).toEqual(Buffer.concat([handshake, update]));
      // Taking over lets input through without reconnecting, once the relay re-reads control.
      expect(
        await takeOverComputer(db, { provider: fake.provider, metering: noMetering }, await member('a'), page),
      ).toMatchObject({
        takeover: { mine: true },
      });
      await until(
        () => sent().includes(keyDown),
        () => browser.send(keyDown),
      );
      // Closing releases the held key on the computer before the relay closes it.
      const relayed = sent().length;
      browser.close();
      await until(() => responses.length === 1);
      expect(responses[0]?.status).toBe(204);
      expect(sent().subarray(relayed)).toEqual(Buffer.from([4, 0, 0, 0, 0, 0, 0, 0x61]));
      expect(computer.clients.size).toBe(0);
    });

    const closeOf = (browser: WebSocket) =>
      new Promise<{ code: number; reason: string }>(resolve =>
        browser.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
      );

    it('ends the relay once the user signs out, with the code that tells the page to wait for its watch', async () => {
      const a = await identity('a');
      const page = randomUUID();
      await open('a');
      await watch('a', page);
      const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/live-view?lease=${page}`;
      const browser = new WebSocket(url, 'binary', { headers: { cookie: a }, origin });
      const closed = closeOf(browser);
      await new Promise(resolve => browser.once('message', resolve));
      // Signed out elsewhere (or revoked, or banned): the watch still runs, but the next re-read ends the relay.
      await db.delete(schema.session);
      expect(await closed).toEqual({ code: 4001, reason: 'not watching' });
      await until(() => computer.clients.size === 0);
    });

    it('closes at once, before reaching the computer, when the computer must be reset for live view', async () => {
      const a = await identity('a');
      const page = randomUUID();
      await open('a');
      await watch('a', page);
      fake.sandboxes.get('sandbox-1')!.public = true;
      const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/live-view?lease=${page}`;
      const browser = new WebSocket(url, 'binary', { headers: { cookie: a }, origin });
      expect(await closeOf(browser)).toEqual({ code: 4002, reason: 'needs reset' });
      expect(upstreamRequests).toHaveLength(0);
      expect(fake.calls.streams).toEqual([]);
    });

    it.runIf(runtime === 'node')(
      'sends only WebSocket frames after the upgrade, not the answer the route returns',
      async () => {
        const a = await identity('a');
        const page = randomUUID();
        await open('a');
        await watch('a', page);
        // The route closes at once and returns its 204 while the socket is still open.
        fake.sandboxes.get('sandbox-1')!.public = true;
        const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
        const chunks: Buffer[] = [];
        socket.on('data', chunk => chunks.push(chunk));
        socket.write(
          [
            `GET /api/v1/live-view?lease=${page} HTTP/1.1`,
            'Host: 127.0.0.1',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
            'Sec-WebSocket-Version: 13',
            `Origin: ${origin}`,
            `Cookie: ${a}`,
            '',
            '',
          ].join('\r\n'),
        );
        await until(() => responses.length === 1);
        await new Promise(resolve => setTimeout(resolve, 100));
        socket.destroy();
        const received = Buffer.concat(chunks).toString('latin1');
        expect(received.startsWith('HTTP/1.1 101 ')).toBe(true);
        expect(received.match(/HTTP\/1\.1/g)).toHaveLength(1);
        expect(received).toContain('needs reset');
      },
    );

    it('refuses the upgrade itself when the page load holds no watch', async () => {
      const a = await identity('a');
      await open('a');
      const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/live-view?lease=${randomUUID()}`;
      const browser = new WebSocket(url, 'binary', { headers: { cookie: a }, origin });
      const refusal = await new Promise<IncomingMessage>(resolve =>
        browser.once('unexpected-response', (_req, res) => resolve(res)),
      );
      expect(refusal.statusCode).toBe(409);
      // On Node, the route's own answer, as on any other request.
      if (runtime === 'node')
        expect(JSON.parse(await refusal.toArray().then(String))).toEqual({ error: 'not_watching' });
      expect(upstreamRequests).toHaveLength(0);
    });
  });
});
