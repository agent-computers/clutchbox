import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { EDGE_ON_WINDOWS, saveFromBrowser, syncingBrowser } from '../../server/src/browser-fixtures';
import { bundle, cookie } from '../../server/src/capture-fixtures';
import { CDP_CLOSE } from '../../server/src/cdp-relay';
import { handBackComputer, listForks, SESSION_ID_PATTERN, takeOverComputer } from '../../server/src/computers';
import type { Member } from '../../server/src/organizations';
import * as schema from '../../server/src/schema';
import { useDeveloperApi } from './developer-api-fixtures';

// Computer sessions over the developer REST API and the CDP proxy, called the way developers call them: through the
// SDK, over real HTTP and WebSockets (developer-api-fixtures.ts). Where a test needs to see what reaches the fork's
// Chrome, a WebSocket server stands in for it; cdp-chromium.test.ts drives a real one.
const developer = useDeveloperApi();
const { person, newKey, opened, refusal, rawRequest, forkRow, computers } = developer;

describe('computer sessions over REST', () => {
  it('open a session for a member on a fork of their computer, with its CDP URL and live-view link, then exec and close it', async () => {
    const admin = await person('admin', 'admin');
    const worker = await person('worker', 'member');
    const { id: keyId, client } = await newKey(admin.cookie);
    const session = await client.computers.open({ member: worker.publicId, label: 'Scrape' });
    expect(SESSION_ID_PATTERN.test(session.id)).toBe(true);
    expect(session.computer).toEqual({ id: expect.any(String), label: 'Scrape', created: true, account: 'deployment' });
    expect(session.cdpUrl).toMatch(/^ws:\/\/localhost:\d+\/api\/v1\/cdp\?token=[A-Za-z0-9_-]{43}$/);
    expect(session.liveViewUrl).toBe(`${developer.origin}/app/computer?computer=${session.computer.id}`);
    expect(session.sync).toEqual({ status: 'none' });
    // The key's session, on the member's fork; only the secret's hash is kept.
    const [row] = await developer.db.select().from(schema.computerSessions);
    expect(row).toMatchObject({ apiKeyId: keyId, clientId: null, membershipId: worker.member.membershipId });
    expect(row!.cdpTokenHash).not.toContain(new URL(session.cdpUrl).searchParams.get('token'));
    // The member sees whose it is on the Computer page.
    expect(await listForks(developer.db, worker.member)).toMatchObject([
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
    expect(developer.fake.sandboxes.get((await forkRow(session.computer.id)).sandboxId!)!.paused).toBe(true);
  });

  it("need the computers scope, act only for the key's organization, and only on the key's own sessions", async () => {
    const admin = await person('admin', 'admin');
    const worker = await person('worker', 'member');
    const outsider = await person('outsider', 'owner', developer.other);
    const { client } = await newKey(admin.cookie);
    const capturesOnly = await newKey(admin.cookie, { capturesOnly: true });
    expect(await refusal(capturesOnly.client.computers.open({ member: worker.publicId }))).toEqual([
      403,
      'insufficient_scope',
    ]);
    expect(await refusal(client.computers.open({ member: outsider.publicId }))).toEqual([404, 'not_found']);
    expect(developer.fake.calls.fork).toBe(0);
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
    await developer.db
      .update(schema.apikey)
      .set({ permissions: JSON.stringify({ captures: ['read'] }) })
      .where(eq(schema.apikey.name, 'Ingest'));
    expect(await refusal(session.exec('true'))).toEqual([403, 'insufficient_scope']);
    // A web session is no key.
    const withCookie = await fetch(`${developer.origin}/api/v1/computers/sessions`, {
      method: 'POST',
      headers: { cookie: admin.cookie, origin: developer.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ member: worker.publicId }),
    });
    expect([withCookie.status, (await withCookie.json()).error]).toEqual([401, 'api_key_required']);
  });

  it('end with the membership, and refuse a deleted key', async () => {
    const admin = await person('admin', 'admin');
    const worker = await person('worker', 'member');
    const key = await newKey(admin.cookie);
    const session = await key.client.computers.open({ member: worker.publicId });
    await developer.db.delete(schema.memberships).where(eq(schema.memberships.id, worker.member.membershipId));
    expect(await refusal(session.exec('true'))).toEqual([404, 'session_not_found']);
    await developer.auth.handler(
      new Request(`${developer.origin}/api/auth/api-key/delete`, {
        method: 'POST',
        headers: { cookie: admin.cookie, origin: developer.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ keyId: key.id }),
      }),
    );
    expect(await refusal(key.client.computers.open({ member: admin.publicId }))).toEqual([401, 'unauthenticated']);
  });

  it("open on one of the member's profiles, list them, and refuse one that is not theirs", async () => {
    const admin = await person('admin', 'admin');
    const worker = await person('worker', 'member');
    const { secret, client } = await newKey(admin.cookie);
    const signIn = async (member: Member, name: string, userAgent?: string) => {
      const browser = await syncingBrowser(developer.db, member, { name, ...(userAgent ? { userAgent } : {}) });
      await saveFromBrowser(developer.db, member, bundle([cookie({ value: name })]), { browser: browser.id });
      return browser;
    };
    const work = await signIn(worker.member, 'work');
    const personal = await signIn(worker.member, 'personal', EDGE_ON_WINDOWS);
    const theirs = await signIn(admin.member, 'admin');
    // The default, the browser synced last, with every profile of the member's.
    const session = await client.computers.open({ member: worker.publicId });
    expect(session.profile).toEqual({
      id: personal.publicId,
      browser: 'edge',
      platform: 'windows',
      lastSyncedAt: expect.any(String),
      default: true,
    });
    expect(session.profiles.map(profile => [profile.id, profile.default])).toEqual([
      [personal.publicId, true],
      [work.publicId, false],
    ]);
    const named = await client.computers.open({
      member: worker.publicId,
      computer: session.computer.id,
      session: session.id,
      profile: work.publicId,
    });
    expect(named.profile?.id).toBe(work.publicId);
    expect(developer.fake.calls.profiles.map(call => call.profile)).toEqual(['default', work.publicId]);
    // A capture: the default profile's, or the one named.
    const values = (latest: { capture: { cookies: { value: string }[] } }) =>
      latest.capture.cookies.map(entry => entry.value);
    expect(values(await client.captures.latest(worker.publicId))).toEqual(['personal']);
    const latest = await client.captures.latest(worker.publicId, { profile: work.publicId });
    expect(latest.profile).toBe(work.publicId);
    expect(values(latest)).toEqual(['work']);
    // Another member's browser is no profile of this one's.
    expect(await refusal(client.computers.open({ member: worker.publicId, profile: theirs.publicId }))).toEqual([
      404,
      'profile_not_found',
    ]);
    expect(await refusal(client.captures.latest(worker.publicId, { profile: theirs.publicId }))).toEqual([
      404,
      'not_found',
    ]);
    expect(
      (await rawRequest(secret, 'POST', '/computers/sessions', { member: worker.publicId, profile: 'brw_x' })).status,
    ).toBe(400);
    expect((await rawRequest(secret, 'GET', `/members/${worker.publicId}/capture?profile=cmp_x`)).status).toBe(400);
  });

  it("switch the computer's screen when asked, and say when it can't", async () => {
    const admin = await person('admin', 'admin');
    const worker = await person('worker', 'member');
    const { client } = await newKey(admin.cookie);
    const session = await client.computers.open({ member: worker.publicId, screen: '1920x1200' });
    expect(session.screenUnchanged).toBe(false);
    const sandbox = developer.fake.sandboxes.get((await forkRow(session.computer.id)).sandboxId!)!;
    expect(sandbox.screen).toEqual({ width: 1920, height: 1200 });
    // A computer from before screen sizes keeps its own.
    Object.assign(sandbox, { screen: { width: 1280, height: 800 }, desktop: { width: 1280, height: 800 } });
    const legacy = await client.computers.open({
      member: worker.publicId,
      computer: session.computer.id,
      session: session.id,
      screen: '1440x900',
    });
    expect(legacy.screenUnchanged).toBe(true);
    expect(sandbox.screen).toEqual({ width: 1280, height: 800 });
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
      { member: worker.publicId, screen: '1024x768' },
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
  it('refuses before upgrading without a live session for a key with the computers scope, or when Chrome is unreachable', async () => {
    const { key, session } = await opened();
    const proxy = `ws://127.0.0.1:${new URL(developer.origin).port}/api/v1/cdp`;
    expect(await handshake(proxy)).toEqual({ status: 401, error: 'unauthenticated' });
    expect(await handshake(`${proxy}?token=short`)).toEqual({ status: 401, error: 'unauthenticated' });
    expect(await handshake(`${proxy}?token=${'a'.repeat(43)}`)).toEqual({ status: 409, error: 'session_ended' });
    const plain = await fetch(session.cdpUrl.replace(/^ws/, 'http'));
    expect(plain.status).toBe(426);
    // Nothing listens where the fork's Chrome should be.
    developer.fake.setCdpUrl('ws://127.0.0.1:9/');
    expect(await handshake(session.cdpUrl)).toEqual({ status: 503, error: 'computer_unavailable' });
    // The attempt's call ended with it.
    expect((await forkRow(session.computer.id)).callsInFlight).toEqual({});
    await developer.db
      .update(schema.apikey)
      .set({ permissions: JSON.stringify({ captures: ['read'] }) })
      .where(eq(schema.apikey.id, key.id));
    expect(await handshake(session.cdpUrl)).toEqual({ status: 403, error: 'access_revoked' });
    await developer.db.delete(schema.apikey).where(eq(schema.apikey.id, key.id));
    // A deleted key's sessions go with it.
    expect(await handshake(session.cdpUrl)).toEqual({ status: 409, error: 'session_ended' });
    const { session: closed } = await opened();
    await closed.close();
    expect(await handshake(closed.cdpUrl)).toEqual({ status: 409, error: 'session_ended' });
    expect(developer.fake.calls.cdpEndpoints).toHaveLength(1);
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
    developer.fake.setCdpUrl(`ws://127.0.0.1:${(chrome.address() as AddressInfo).port}/`);
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
      await takeOverComputer(developer.db, computers(), worker.member as Member, lease, {
        computerId: session.computer.id,
      });
      await vi.waitFor(() => expect(codes).toEqual([CDP_CLOSE.userInControl]), { timeout: 5_000 });
      expect(await session.state()).toBe('user_in_control');
      await handBackComputer(developer.db, computers(), worker.member, lease, { computerId: session.computer.id });
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
