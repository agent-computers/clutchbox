import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { HEARTBEAT_MS, LIVE_VIEW_CLOSE_MARGIN_MS, LIVE_VIEW_PING_MS } from './computer-timing';
import { RELAY_CLOSE, type RelayLog, type RelayOptions, relay } from './live-view-relay';

// Real sockets on 127.0.0.1: a fake computer (websockify), a relay server, and a browser client.

type Computer = { socket: WebSocket; received: Buffer[]; closed: Promise<number>; pings: number };
type Access = Awaited<ReturnType<RelayOptions['access']>>;

const servers: WebSocketServer[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) client.terminate();
  await Promise.all(
    servers.splice(0).map(server => {
      for (const client of server.clients) client.terminate();
      return new Promise(resolve => server.close(resolve));
    }),
  );
});

function listen(): Promise<WebSocketServer> {
  return new Promise(resolve => {
    const server: WebSocketServer = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => resolve(server));
    servers.push(server);
  });
}

function url(server: WebSocketServer) {
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

async function setup(options: Partial<Omit<RelayOptions, 'browser' | 'upstream'>> = {}) {
  const computerServer = await listen();
  const computers: Computer[] = [];
  const computerConnected = new Promise<Computer>(resolve =>
    computerServer.on('connection', socket => {
      const computer: Computer = {
        socket,
        received: [],
        pings: 0,
        closed: new Promise(done => socket.on('close', code => done(code))),
      };
      socket.on('message', data => computer.received.push(data as Buffer));
      socket.on('ping', () => {
        computer.pings += 1;
      });
      computers.push(computer);
      resolve(computer);
    }),
  );
  const logs: RelayLog[] = [];
  const access = options.access ?? vi.fn(async (): Promise<Access> => 'view');
  let ended: Promise<void> | undefined;
  let sockets: { browser: WebSocket; upstream: WebSocket } | undefined;
  const relayServer = await listen();
  relayServer.on('connection', browser => {
    const upstream = new WebSocket(url(computerServer), 'binary');
    upstream.once('open', () => {
      sockets = { browser, upstream };
      ended = relay({
        browser,
        upstream,
        access,
        deadlineMs: Date.now() + 60 * 60_000,
        log: entry => logs.push(entry),
        ...options,
      });
    });
  });
  const browser = new WebSocket(url(relayServer));
  clients.push(browser);
  const received: Buffer[] = [];
  browser.on('message', data => received.push(data as Buffer));
  const browserClosed = new Promise<{ code: number; reason: string }>(resolve =>
    browser.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  await new Promise(resolve => browser.once('open', resolve));
  const computer = await computerConnected;
  // The relay starts once the upstream socket opens, a tick after the computer sees it.
  await vi.waitFor(() => expect(ended).toBeDefined());
  return {
    browser,
    computer,
    received,
    browserClosed,
    logs,
    access,
    // The relay's own ends of the two connections.
    relaySockets: sockets as { browser: WebSocket; upstream: WebSocket },
    ended: () => ended as Promise<void>,
  };
}

const handshake = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]);
const updateRequest = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const keyDown = (keysym: number) =>
  Buffer.from([4, 1, 0, 0, keysym >>> 24, (keysym >>> 16) & 255, (keysym >>> 8) & 255, keysym & 255]);
const keyUp = (keysym: number) =>
  Buffer.from([4, 0, 0, 0, keysym >>> 24, (keysym >>> 16) & 255, (keysym >>> 8) & 255, keysym & 255]);
const pointer = (mask: number) => Buffer.from([5, mask, 0, 10, 0, 20]);

const upstreamBytes = (computer: Computer) => Buffer.concat(computer.received);

describe('relay', () => {
  it('passes the computer bytes through untouched and forwards a watcher only the handshake and framebuffer messages', async () => {
    const { browser, computer, received } = await setup();
    const frames = [Buffer.from('RFB 003.008\n'), randomBytes(3 * 1024 * 1024), Buffer.from([0, 0, 0, 1])];
    for (const frame of frames) computer.socket.send(frame);
    await vi.waitFor(() => expect(received).toHaveLength(frames.length));
    expect(Buffer.concat(received).equals(Buffer.concat(frames))).toBe(true);

    browser.send(handshake);
    browser.send(Buffer.concat([keyDown(0x61), pointer(1), updateRequest]));
    await vi.waitFor(() => expect(upstreamBytes(computer)).toEqual(Buffer.concat([handshake, updateRequest])));
  });

  it('closes both sides with a policy violation on a text frame', async () => {
    const { browser, computer, browserClosed, logs } = await setup();
    browser.send('RFB 003.008\n');
    expect(await browserClosed).toEqual({ code: RELAY_CLOSE.policy, reason: 'binary only' });
    expect(await computer.closed).toBe(1000);
    expect(upstreamBytes(computer)).toHaveLength(0);
    expect(logs).toContainEqual(expect.objectContaining({ event: 'live_view.relay_end', cause: 'text' }));
  });

  it('closes both sides on a message the filter does not know, naming only its type', async () => {
    const { browser, computer, browserClosed, logs } = await setup();
    browser.send(Buffer.concat([handshake, Buffer.from([7, 0, 0, 0])]));
    expect(await browserClosed).toEqual({ code: RELAY_CLOSE.policy, reason: 'type 7' });
    expect(await computer.closed).toBe(1000);
    expect(upstreamBytes(computer)).toEqual(handshake);
    expect(logs).toContainEqual(expect.objectContaining({ cause: 'filter', reason: 'type 7' }));
  });

  it('re-reads control when it drops input, at most every recheck interval, and forwards input once in control', async () => {
    let inControl = false;
    const access = vi.fn(async (): Promise<Access> => (inControl ? 'control' : 'view'));
    const onDroppedInput = vi.fn();
    const { browser, computer } = await setup({ access, onDroppedInput });
    await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(1));
    browser.send(handshake);

    inControl = true;
    for (let i = 0; i < 5; i++) browser.send(keyDown(0x61));
    await vi.waitFor(() => expect(onDroppedInput).toHaveBeenCalledTimes(5));
    // The first read was just now, so one re-read follows the recheck interval rather than one per drop.
    await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(2));
    browser.send(keyDown(0x62));
    await vi.waitFor(() => expect(upstreamBytes(computer)).toEqual(Buffer.concat([handshake, keyDown(0x62)])));
    expect(access).toHaveBeenCalledTimes(2);
  });

  it('releases held keys and buttons when control is lost on a heartbeat re-read, without closing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    let inControl = true;
    const access = vi.fn(async (): Promise<Access> => (inControl ? 'control' : 'view'));
    const { browser, computer, received } = await setup({ access });
    await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(1));
    browser.send(Buffer.concat([handshake, keyDown(0xffe1), keyDown(0x61), keyUp(0x61), pointer(1)]));
    await vi.waitFor(() => expect(upstreamBytes(computer).length).toBe(handshake.length + 3 * 8 + 6));

    inControl = false;
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(2));
    const releases = Buffer.concat([keyUp(0xffe1), pointer(0)]);
    await vi.waitFor(() => expect(upstreamBytes(computer).subarray(-releases.length)).toEqual(releases));

    browser.send(keyDown(0x61));
    computer.socket.send(Buffer.from([1, 2, 3]));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(upstreamBytes(computer).subarray(-releases.length)).toEqual(releases);
  });

  it('counts a failed control read as no control, without ending the stream', async () => {
    const access = vi.fn(async (): Promise<Access> => {
      throw Object.assign(new Error('postgres://user:secret@db'), { code: '57P01' });
    });
    const { browser, computer, logs } = await setup({ access });
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(logs[0]).toEqual({ event: 'live_view.relay_error', side: 'control', error: 'Error (57P01)' });
    browser.send(Buffer.concat([handshake, keyDown(0x61), updateRequest]));
    await vi.waitFor(() => expect(upstreamBytes(computer)).toEqual(Buffer.concat([handshake, updateRequest])));
  });

  it('releases held input and closes the computer side when the browser closes', async () => {
    const { browser, computer, logs, ended } = await setup({ access: async () => 'control' });
    await new Promise(resolve => setTimeout(resolve, 50));
    browser.send(Buffer.concat([handshake, keyDown(0x61)]));
    await vi.waitFor(() => expect(upstreamBytes(computer).length).toBe(handshake.length + 8));
    browser.close(1000);
    expect(await computer.closed).toBe(1000);
    expect(upstreamBytes(computer)).toEqual(Buffer.concat([handshake, keyDown(0x61), keyUp(0x61)]));
    await ended();
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'live_view.relay_end', cause: 'browser', code: 1000 }),
    );
  });

  it('ends with not watching once the lease holds neither a watch nor the takeover, releasing held input', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    let allowed: Access = 'control';
    const access = vi.fn(async () => allowed);
    const { browser, computer, browserClosed, logs, ended } = await setup({ access });
    await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(1));
    browser.send(Buffer.concat([handshake, keyDown(0x61)]));
    await vi.waitFor(() => expect(upstreamBytes(computer).length).toBe(handshake.length + 8));
    // Released, lapsed, or the user's sign-in ended.
    allowed = 'none';
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(await browserClosed).toEqual({ code: RELAY_CLOSE.notWatching, reason: 'not watching' });
    expect(await computer.closed).toBe(1000);
    expect(upstreamBytes(computer)).toEqual(Buffer.concat([handshake, keyDown(0x61), keyUp(0x61)]));
    await ended();
    expect(logs).toContainEqual(expect.objectContaining({ event: 'live_view.relay_end', cause: 'access' }));
  });

  it('closes the browser when the computer side closes', async () => {
    const { computer, browserClosed, ended } = await setup();
    computer.socket.close(1000);
    expect(await browserClosed).toEqual({ code: RELAY_CLOSE.computerClosed, reason: 'computer closed' });
    await ended();
  });

  it('asks the page to reconnect the close margin before the deadline', async () => {
    const { computer, browserClosed, logs, ended } = await setup({
      deadlineMs: Date.now() + LIVE_VIEW_CLOSE_MARGIN_MS + 300,
    });
    expect(await browserClosed).toEqual({ code: RELAY_CLOSE.reconnect, reason: 'reconnect' });
    expect(await computer.closed).toBe(1000);
    await ended();
    expect(logs).toContainEqual(expect.objectContaining({ event: 'live_view.relay_end', cause: 'deadline' }));
  });

  it('asks the page to reconnect when the server shuts down, or at once if it already has', async () => {
    const shutdown = new AbortController();
    const running = await setup({ stop: shutdown.signal });
    shutdown.abort();
    expect(await running.browserClosed).toEqual({ code: RELAY_CLOSE.reconnect, reason: 'reconnect' });
    expect(await running.computer.closed).toBe(1000);
    await running.ended();
    expect(running.logs).toContainEqual(expect.objectContaining({ event: 'live_view.relay_end', cause: 'shutdown' }));
    const late = await setup({ stop: AbortSignal.abort() });
    expect(await late.browserClosed).toEqual({ code: RELAY_CLOSE.reconnect, reason: 'reconnect' });
  });

  it('pings both sides', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const { browser, computer } = await setup();
    let browserPings = 0;
    browser.on('ping', () => {
      browserPings += 1;
    });
    vi.advanceTimersByTime(LIVE_VIEW_PING_MS);
    await vi.waitFor(() => expect([browserPings, computer.pings]).toEqual([1, 1]));
  });

  it('pauses the computer side while the browser is backed up, then delivers every byte', async () => {
    const { browser, computer, received, relaySockets } = await setup();
    const pause = vi.spyOn(relaySockets.upstream, 'pause');
    const resume = vi.spyOn(relaySockets.upstream, 'resume');
    let mostBuffered = 0;
    const send = relaySockets.browser.send.bind(relaySockets.browser);
    vi.spyOn(relaySockets.browser, 'send').mockImplementation((...args: Parameters<typeof send>) => {
      send(...args);
      mostBuffered = Math.max(mostBuffered, relaySockets.browser.bufferedAmount);
    });
    browser.pause();
    const chunks = Array.from({ length: 64 }, () => randomBytes(1024 * 1024));
    for (const chunk of chunks) computer.socket.send(chunk);
    await vi.waitFor(() => expect(pause).toHaveBeenCalled(), { timeout: 10_000 });
    // Let the computer keep sending into the paused relay for a while.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(resume).not.toHaveBeenCalled();
    browser.resume();
    await vi.waitFor(() => expect(received).toHaveLength(chunks.length), { timeout: 20_000 });
    expect(resume).toHaveBeenCalled();
    expect(Buffer.concat(received).equals(Buffer.concat(chunks))).toBe(true);
    // Bounded by the high-water mark plus what was already read when the relay paused, not the 64 MiB sent.
    expect(mostBuffered).toBeLessThan(24 * 1024 * 1024);
  });
});
