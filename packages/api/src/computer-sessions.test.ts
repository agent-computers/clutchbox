import { type ChildProcess, spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseSchema } from '@agent-computers/server/database-schema';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { chromium } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { ClutchboxError, createClient } from '../../sdk/src/index';
import { createAuth } from '../../server/src/auth';
import { CDP_CLOSE } from '../../server/src/cdp-relay';
import { CDP_MAX_DURATION_MS } from '../../server/src/computer-timing';
import { handBackComputer, listForks, SESSION_ID_PATTERN, takeOverComputer } from '../../server/src/computers';
import type { ServerConfig } from '../../server/src/config';
import type { Database } from '../../server/src/database';
import { fakeComputerProvider } from '../../server/src/fake-computer-provider';
import { noMetering } from '../../server/src/hooks';
import { membership } from '../../server/src/member-fixtures';
import type { Role } from '../../server/src/members';
import { createOrganization, type Member } from '../../server/src/organizations';
import * as schema from '../../server/src/schema';
import { cdpHandler } from './cdp';
import { createApi } from './index';
import { nodeServer } from './node-upgrade';

// Computer sessions over the developer REST API and the CDP proxy, in process against PGlite and real Better Auth, on
// the web app's Node server, called the way developers call them: through the SDK. A fake provider stands in for
// E2B; the fork's Chrome is a real Chromium, or a WebSocket server where a test needs to see what reaches it.
let template: PGlite;
let pg: PGlite;
let db: Database;
let auth: ReturnType<typeof createAuth>;
let fake: ReturnType<typeof fakeComputerProvider>;
let server: Server;
let origin: string;
let config: ServerConfig;
let acme: string;
let other: string;

const api = () => createApi({ db, auth, origin, computers: fake.provider });
// A Node request as a fetch Request, body included.
async function toRequest(request: IncomingMessage) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value);
  const hasBody = !['GET', 'HEAD'].includes(request.method ?? 'GET');
  const chunks: Buffer[] = [];
  if (hasBody) for await (const chunk of request) chunks.push(chunk as Buffer);
  return new Request(`${origin}${request.url}`, {
    method: request.method ?? 'GET',
    headers,
    ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
  });
}
beforeAll(async () => {
  template = new PGlite();
  await migrate(drizzle(template, { schema: databaseSchema }), {
    migrationsFolder: fileURLToPath(new URL('../../server/migrations', import.meta.url)),
  });
  // The framework's request listener, as Next.js runs the routes: the CDP proxy on its own route, the API's, and Better
  // Auth's.
  const listener = async (request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? '/';
    const fetched = await toRequest(request);
    const answer = url.startsWith('/api/v1/cdp')
      ? await cdpHandler({ db, computers: fake.provider })(fetched)
      : url.startsWith('/api/auth')
        ? await auth.handler(fetched)
        : await api().fetch(fetched);
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(Buffer.from(await answer.arrayBuffer()));
  };
  server = nodeServer(listener);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config = {
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/synthetic',
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
    GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'synthetic-only',
  };
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  await template.close();
});
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  db = drizzle(pg, { schema: databaseSchema }) as unknown as Database;
  await db.insert(schema.installation).values({ dataClass: 'nonproduction' });
  auth = createAuth(db, config);
  await auth.$context;
  fake = fakeComputerProvider();
  vi.stubEnv('CAPTURE_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  for (const id of ['founder', 'stranger'])
    await db.insert(schema.user).values({ id, name: id, email: `${id}@acme.test`, emailVerified: true });
  acme = (await db.transaction(tx =>
    createOrganization(tx, { name: 'Acme', owner: { id: 'founder', name: 'founder', email: 'founder@acme.test' } }),
  ))!;
  other = (await db.transaction(tx =>
    createOrganization(tx, { name: 'Other', owner: { id: 'stranger', name: 'stranger', email: 'stranger@acme.test' } }),
  ))!;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

// A signed-in person with a role in an organization.
async function person(id: string, role: Role, organizationId = acme) {
  await db
    .insert(schema.user)
    .values({ id, name: `Fixture ${id}`, email: `${id}@acme.test`, emailVerified: true })
    .onConflictDoNothing();
  const member = await membership(db, id, organizationId);
  await db.update(schema.memberships).set({ role }).where(eq(schema.memberships.id, member.membershipId));
  const token = randomBytes(32).toString('base64url');
  await db
    .insert(schema.session)
    .values({ id: randomUUID(), userId: id, token, expiresAt: new Date(Date.now() + 3600_000) });
  const signature = createHmac('sha256', config.BETTER_AUTH_SECRET).update(token).digest('base64');
  const cookie = `${(await auth.$context).authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
  const publicId = (
    await db
      .select({ publicId: schema.memberships.publicId })
      .from(schema.memberships)
      .where(eq(schema.memberships.id, member.membershipId))
  )[0]!.publicId;
  return { cookie, member, publicId };
}
// A key for the organization, made by an owner or admin on the Developers page; with every scope, as new keys are, or
// with captures alone, as keys made before the computers scope are.
async function newKey(cookie: string, { capturesOnly = false, organizationId = acme } = {}) {
  const response = await auth.handler(
    new Request(`${origin}/api/auth/api-key/create`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ingest', organizationId }),
    }),
  );
  expect(response.status).toBe(200);
  const { id, key } = await response.json();
  if (capturesOnly)
    await db
      .update(schema.apikey)
      .set({ permissions: JSON.stringify({ captures: ['read'] }) })
      .where(eq(schema.apikey.id, id));
  return { id: id as string, secret: key as string, client: createClient({ server: origin, apiKey: key }) };
}
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    error => (error instanceof ClutchboxError ? [error.status, error.code] : error),
  );
const rawRequest = (secret: string, method: string, route: string, body?: unknown) =>
  fetch(`${origin}/api/v1${route}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
const forkRow = async (computerId: string) =>
  (await db.select().from(schema.computers).where(eq(schema.computers.publicId, computerId)))[0]!;
const computers = () => ({ provider: fake.provider, metering: noMetering });

describe('computer sessions over REST', () => {
  it('open a session for a member on a fork of their computer, with its CDP URL and live-view link, then exec and close it', async () => {
    const admin = await person('admin', 'admin');
    const worker = await person('worker', 'member');
    const { id: keyId, client } = await newKey(admin.cookie);
    const session = await client.computers.open({ member: worker.publicId, label: 'Scrape' });
    expect(SESSION_ID_PATTERN.test(session.id)).toBe(true);
    expect(session.computer).toEqual({ id: expect.any(String), label: 'Scrape', created: true });
    expect(session.cdpUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/api\/v1\/cdp\?token=[A-Za-z0-9_-]{43}$/);
    expect(session.liveViewUrl).toBe(`${origin}/app/computer?computer=${session.computer.id}`);
    expect(session.sync).toEqual({ status: 'none' });
    // The key's session, on the member's fork; only the secret's hash is kept.
    const [row] = await db.select().from(schema.computerSessions);
    expect(row).toMatchObject({ apiKeyId: keyId, clientId: null, membershipId: worker.member.membershipId });
    expect(row!.cdpTokenHash).not.toContain(new URL(session.cdpUrl).searchParams.get('token'));
    // The member sees whose it is on the Computer page.
    expect(await listForks(db, worker.member)).toMatchObject([
      { computerId: session.computer.id, agent: { agent: null, host: 'Ingest API key' } },
    ]);
    expect(await session.exec('echo hi', { cwd: '/home/user' })).toEqual({
      exitCode: 0,
      stdout: 'ran: echo hi',
      stderr: '',
      truncated: false,
      timedOut: false,
    });
    expect(await session.state()).toBe('open');
    // Reopening its computer while the session holds it waits, unless it names the session it replaces.
    expect(await refusal(client.computers.open({ member: worker.publicId, computer: session.computer.id }))).toEqual([
      409,
      'busy',
    ]);
    const reopened = await client.computers.open({
      member: worker.publicId,
      computer: session.computer.id,
      session: session.id,
    });
    expect(reopened.computer).toMatchObject({ id: session.computer.id, created: false });
    expect(reopened.cdpUrl).not.toBe(session.cdpUrl);
    expect(await session.state()).toBe('ended');
    expect(await refusal(session.exec('true'))).toEqual([409, 'session_ended']);
    await reopened.close();
    expect(await reopened.state()).toBe('ended');
    expect(await refusal(reopened.exec('true'))).toEqual([409, 'session_ended']);
    expect(await refusal(reopened.close())).toEqual([409, 'session_ended']);
    // The fork is paused, with what was on it, for the next open.
    expect(fake.sandboxes.get((await forkRow(session.computer.id)).sandboxId!)!.paused).toBe(true);
  });

  it("need the computers scope, act only for the key's organization, and only on the key's own sessions", async () => {
    const admin = await person('admin', 'admin');
    const worker = await person('worker', 'member');
    const outsider = await person('outsider', 'owner', other);
    const { client } = await newKey(admin.cookie);
    const capturesOnly = await newKey(admin.cookie, { capturesOnly: true });
    expect(await refusal(capturesOnly.client.computers.open({ member: worker.publicId }))).toEqual([
      403,
      'insufficient_scope',
    ]);
    expect(await refusal(client.computers.open({ member: outsider.publicId }))).toEqual([404, 'not_found']);
    expect(fake.calls.fork).toBe(0);
    const session = await client.computers.open({ member: worker.publicId });
    // Another key of the same organization can't see or use it.
    const second = await newKey(admin.cookie);
    for (const attempt of [
      second.client.computers.state(session.id),
      second.client.computers.exec(session.id, 'true'),
      second.client.computers.close(session.id),
      second.client.computers.exec('cs_nonsense', 'true'),
    ])
      expect(await refusal(attempt)).toEqual([404, 'session_not_found']);
    expect(await refusal(capturesOnly.client.computers.exec(session.id, 'true'))).toEqual([403, 'insufficient_scope']);
    // A key that loses the scope can no longer use its sessions.
    await db
      .update(schema.apikey)
      .set({ permissions: JSON.stringify({ captures: ['read'] }) })
      .where(eq(schema.apikey.name, 'Ingest'));
    expect(await refusal(session.exec('true'))).toEqual([403, 'insufficient_scope']);
    // A web session is no key.
    const withCookie = await fetch(`${origin}/api/v1/computers/sessions`, {
      method: 'POST',
      headers: { cookie: admin.cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ member: worker.publicId }),
    });
    expect([withCookie.status, (await withCookie.json()).error]).toEqual([401, 'api_key_required']);
  });

  it('end with the membership, and refuse a deleted key', async () => {
    const admin = await person('admin', 'admin');
    const worker = await person('worker', 'member');
    const key = await newKey(admin.cookie);
    const session = await key.client.computers.open({ member: worker.publicId });
    await db.delete(schema.memberships).where(eq(schema.memberships.id, worker.member.membershipId));
    expect(await refusal(session.exec('true'))).toEqual([404, 'session_not_found']);
    await auth.handler(
      new Request(`${origin}/api/auth/api-key/delete`, {
        method: 'POST',
        headers: { cookie: admin.cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ keyId: key.id }),
      }),
    );
    expect(await refusal(key.client.computers.open({ member: admin.publicId }))).toEqual([401, 'unauthenticated']);
  });

  it('refuse malformed requests', async () => {
    const admin = await person('admin', 'admin');
    const worker = await person('worker', 'member');
    const { secret, client } = await newKey(admin.cookie);
    for (const body of [
      {},
      { member: 'mem_x' },
      { member: worker.publicId, computer: 'nope' },
      { member: worker.publicId, label: '' },
      { member: worker.publicId, extra: true },
      'not json',
    ])
      expect((await rawRequest(secret, 'POST', '/computers/sessions', body)).status, JSON.stringify(body)).toBe(400);
    const session = await client.computers.open({ member: worker.publicId });
    for (const body of [{}, { command: '' }, { command: 'true', timeoutSeconds: 91 }, { command: 'true', cwd: 'tmp' }])
      expect(
        (await rawRequest(secret, 'POST', `/computers/sessions/${session.id}/exec`, body)).status,
        JSON.stringify(body),
      ).toBe(400);
  });
});

describe('the CDP proxy', () => {
  // A WebSocket handshake to the proxy, refused or not: the status and error, or the open socket.
  const handshake = (url: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; error?: string } | { socket: WebSocket }>((resolve, reject) => {
      const socket = new WebSocket(url, { headers });
      socket.once('unexpected-response', async (_request, response) => {
        const body = JSON.parse(await response.toArray().then(String));
        resolve({ status: response.statusCode!, error: body.error });
      });
      socket.once('open', () => resolve({ socket }));
      socket.once('error', reject);
    });
  const opened = async () => {
    const admin = await person('admin', 'admin');
    const worker = await person('worker', 'member');
    const key = await newKey(admin.cookie);
    return { key, worker, session: await key.client.computers.open({ member: worker.publicId }) };
  };

  it('refuses before upgrading without a live session for a key with the computers scope, or when Chrome is unreachable', async () => {
    const { key, session } = await opened();
    const proxy = `ws://127.0.0.1:${new URL(origin).port}/api/v1/cdp`;
    expect(await handshake(proxy)).toEqual({ status: 401, error: 'unauthenticated' });
    expect(await handshake(`${proxy}?token=short`)).toEqual({ status: 401, error: 'unauthenticated' });
    expect(await handshake(`${proxy}?token=${'a'.repeat(43)}`)).toEqual({ status: 409, error: 'session_ended' });
    const plain = await fetch(session.cdpUrl.replace(/^ws/, 'http'));
    expect(plain.status).toBe(426);
    // Nothing listens where the fork's Chrome should be.
    fake.setCdpUrl('ws://127.0.0.1:9/');
    expect(await handshake(session.cdpUrl)).toEqual({ status: 503, error: 'computer_unavailable' });
    // The attempt's call ended with it.
    expect((await forkRow(session.computer.id)).callsInFlight).toEqual({});
    await db
      .update(schema.apikey)
      .set({ permissions: JSON.stringify({ captures: ['read'] }) })
      .where(eq(schema.apikey.id, key.id));
    expect(await handshake(session.cdpUrl)).toEqual({ status: 403, error: 'access_revoked' });
    await db.delete(schema.apikey).where(eq(schema.apikey.id, key.id));
    // A deleted key's sessions go with it.
    expect(await handshake(session.cdpUrl)).toEqual({ status: 409, error: 'session_ended' });
    const { session: closed } = await opened();
    await closed.close();
    expect(await handshake(closed.cdpUrl)).toEqual({ status: 409, error: 'session_ended' });
    expect(fake.calls.cdpEndpoints).toHaveLength(1);
  });

  describe('with a real Chromium', () => {
    let chrome: ChildProcess;
    let chromeUrl: string;
    beforeAll(async () => {
      const port = 9300 + Math.floor(Math.random() * 500);
      chrome = spawn(chromium.executablePath(), [
        '--headless=new',
        // As Playwright launches it: CI runners (Ubuntu 24.04) block the sandbox's user namespaces.
        '--no-sandbox',
        `--remote-debugging-port=${port}`,
        // The computer's bridge drops the Origin it checks; here the proxy reaches Chrome directly, with it.
        '--remote-allow-origins=agent-computers-relay',
        `--user-data-dir=${await mkdtemp(path.join(tmpdir(), 'cdp-'))}`,
        'about:blank',
      ]);
      for (let i = 0; !chromeUrl && i < 200; i++) {
        const version = await fetch(`http://127.0.0.1:${port}/json/version`)
          .then(response => response.json())
          .catch(() => null);
        if (version) chromeUrl = version.webSocketDebuggerUrl;
        else await new Promise(resolve => setTimeout(resolve, 100));
      }
    });
    afterAll(() => {
      chrome.kill();
    });

    it("lets Playwright drive the fork's Chrome, holding the session while connected, until it is closed", async () => {
      const { session } = await opened();
      fake.setCdpUrl(chromeUrl);
      const browser = await chromium.connectOverCDP(session.cdpUrl);
      const disconnected = new Promise(resolve => browser.once('disconnected', resolve));
      const page = await browser.contexts()[0]!.newPage();
      await page.setContent('<title>On the fork</title>');
      expect(await page.title()).toBe('On the fork');
      // The connection is one call of the session, holding control until the platform's limit at most.
      const [call] = Object.values((await forkRow(session.computer.id)).callsInFlight);
      expect(Date.parse(call!.until) - Date.now()).toBeGreaterThan(CDP_MAX_DURATION_MS - 30_000);
      expect(await session.state()).toBe('open');
      await page.close();
      // Closing the session ends the connection at the next re-check, and its call.
      await session.close();
      await disconnected;
      await vi.waitFor(async () => expect((await forkRow(session.computer.id)).callsInFlight).toEqual({}));
    });
  });

  it("closes for the member's takeover, and the SDK reconnects after the hand-back and after a drop", async () => {
    const { session, worker } = await opened();
    // The fork's Chrome, as reached through its bridge.
    const chrome = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise(resolve => chrome.once('listening', resolve));
    const upstream: IncomingMessage[] = [];
    const chromeSockets: WebSocket[] = [];
    chrome.on('connection', (socket, request) => {
      upstream.push(request);
      chromeSockets.push(socket);
    });
    fake.setCdpUrl(`ws://127.0.0.1:${(chrome.address() as AddressInfo).port}/`);
    try {
      const codes: number[] = [];
      let connects = 0;
      let ended = false;
      const connection = await session.keepConnected({
        connect: url =>
          new Promise<WebSocket>((resolve, reject) => {
            const socket = new WebSocket(url);
            socket.once('open', () => resolve(socket));
            socket.once('unexpected-response', () => reject(new Error('refused')));
            socket.once('error', reject);
          }),
        disconnected: socket =>
          new Promise(resolve =>
            socket.once('close', code => {
              codes.push(code);
              resolve(code);
            }),
          ),
        onConnect: () => {
          connects += 1;
        },
        onEnd: () => {
          ended = true;
        },
      });
      expect(connects).toBe(1);
      // The fork's Chrome got the provider's traffic token, and the Origin its bridge accepts.
      expect(upstream[0]!.headers).toMatchObject({
        'e2b-traffic-access-token': `token-${(await forkRow(session.computer.id)).sandboxId}`,
        origin: 'agent-computers-relay',
      });
      const lease = randomUUID();
      await takeOverComputer(db, computers(), worker.member as Member, lease, { computerId: session.computer.id });
      await vi.waitFor(() => expect(codes).toEqual([CDP_CLOSE.userInControl]), { timeout: 5_000 });
      expect(await session.state()).toBe('user_in_control');
      await handBackComputer(db, computers(), worker.member, lease, { computerId: session.computer.id });
      await vi.waitFor(() => expect(connects).toBe(2), { timeout: 10_000 });
      // A drop while the session is open reconnects at once.
      chromeSockets[1]!.close();
      await vi.waitFor(() => expect(connects).toBe(3), { timeout: 5_000 });
      expect(codes).toEqual([CDP_CLOSE.userInControl, CDP_CLOSE.computerClosed]);
      // Closing the session ends the connection for good.
      await session.close();
      await connection.done;
      expect(codes.at(-1)).toBe(CDP_CLOSE.sessionEnded);
      expect([connects, ended]).toEqual([3, false]);
    } finally {
      for (const socket of chrome.clients) socket.terminate();
      await new Promise(resolve => chrome.close(resolve));
    }
  }, 30_000);
});
