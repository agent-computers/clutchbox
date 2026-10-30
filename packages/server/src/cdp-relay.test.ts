import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { CDP_CLOSE, type CdpAccess, type CdpRelayLog, type CdpRelayOptions, cdpRelay } from './cdp-relay';
import { CDP_ACCESS_RECHECK_MS, CDP_CLOSE_MARGIN_MS } from './computer-timing';

// Real sockets on 127.0.0.1: a stand-in for the fork's Chrome, the relay's server, and a developer's CDP client.

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
const listen = () =>
  new Promise<WebSocketServer>(resolve => {
    const server: WebSocketServer = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => resolve(server));
    servers.push(server);
  });
const url = (server: WebSocketServer) => `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`;

async function setup(options: Partial<Omit<CdpRelayOptions, 'client' | 'upstream'>> = {}) {
  // Chrome answers each command with its id, and sends an event first.
  const chrome = await listen();
  const chromeSockets: WebSocket[] = [];
  chrome.on('connection', socket => {
    chromeSockets.push(socket);
    socket.on('message', data => {
      const { id, method } = JSON.parse(String(data));
      socket.send(JSON.stringify({ method: 'Target.targetCreated', params: { secret: 'page-content' } }));
      socket.send(JSON.stringify({ id, result: { echoed: method } }));
    });
  });
  const logs: CdpRelayLog[] = [];
  let ended: Promise<void> | undefined;
  const relayServer = await listen();
  relayServer.on('connection', client => {
    const upstream = new WebSocket(url(chrome));
    upstream.once('open', () => {
      ended = cdpRelay({
        client,
        upstream,
        access: async () => 'open',
        deadlineMs: Date.now() + 60 * 60_000,
        log: entry => logs.push(entry),
        ...options,
      });
    });
  });
  const client = new WebSocket(url(relayServer));
  clients.push(client);
  const received: unknown[] = [];
  client.on('message', data => received.push(JSON.parse(String(data))));
  const closed = new Promise<{ code: number; reason: string }>(resolve =>
    client.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  await new Promise(resolve => client.once('open', resolve));
  await vi.waitFor(() => expect(chromeSockets).toHaveLength(1));
  return { client, received, closed, logs, chromeSockets, ended: () => ended };
}

describe('CDP relay', () => {
  it('passes commands to Chrome and its replies and events back, logging none of them', async () => {
    const { client, received, logs, closed } = await setup();
    client.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received).toEqual([
      { method: 'Target.targetCreated', params: { secret: 'page-content' } },
      { id: 1, result: { echoed: 'Browser.getVersion' } },
    ]);
    client.close(1000);
    expect((await closed).code).toBe(1000);
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(logs[0]).toMatchObject({ event: 'cdp.relay_end', cause: 'client', code: 1000 });
    expect(JSON.stringify(logs)).not.toMatch(/secret|Browser|page-content/);
  });

  it('asks the client to reconnect the close margin before the deadline', async () => {
    const { closed, chromeSockets } = await setup({ deadlineMs: Date.now() + CDP_CLOSE_MARGIN_MS + 200 });
    expect(await closed).toEqual({ code: CDP_CLOSE.reconnect, reason: 'reconnect' });
    await vi.waitFor(() => expect(chromeSockets[0]!.readyState).toBe(WebSocket.CLOSED));
  });

  it('asks the client to reconnect when the server shuts down, or at once if it already has', async () => {
    const shutdown = new AbortController();
    const running = await setup({ stop: shutdown.signal });
    shutdown.abort();
    expect(await running.closed).toEqual({ code: CDP_CLOSE.reconnect, reason: 'reconnect' });
    await vi.waitFor(() => expect(running.chromeSockets[0]!.readyState).toBe(WebSocket.CLOSED));
    expect(running.logs).toContainEqual(expect.objectContaining({ event: 'cdp.relay_end', cause: 'shutdown' }));
    const late = await setup({ stop: AbortSignal.abort() });
    expect(await late.closed).toEqual({ code: CDP_CLOSE.reconnect, reason: 'reconnect' });
  });

  it.each([
    ['ended', CDP_CLOSE.sessionEnded, 'session ended'],
    ['user_in_control', CDP_CLOSE.userInControl, 'user in control'],
  ] as const)('closes once the session is %s, on the next re-check', async (state, code, reason) => {
    let now: CdpAccess = 'open';
    const { closed } = await setup({ access: async () => now });
    now = state;
    const started = Date.now();
    expect(await closed).toEqual({ code, reason });
    expect(Date.now() - started).toBeLessThan(CDP_ACCESS_RECHECK_MS + 1_000);
  });

  it('keeps the connection when a re-check fails, logging only the error class', async () => {
    let reads = 0;
    const { client, received, logs } = await setup({
      access: async () => {
        reads += 1;
        throw new Error('db down with token abc');
      },
    });
    await vi.waitFor(() => expect(reads).toBeGreaterThan(0), { timeout: CDP_ACCESS_RECHECK_MS + 1_000 });
    client.send(JSON.stringify({ id: 2, method: 'Target.getTargets' }));
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(logs).toEqual([{ event: 'cdp.relay_error', side: 'access', error: 'Error' }]);
  });

  it('closes the client when Chrome closes, and resolves once both sides have', async () => {
    const { closed, chromeSockets, ended } = await setup();
    chromeSockets[0]!.close();
    expect(await closed).toEqual({ code: CDP_CLOSE.computerClosed, reason: 'computer closed' });
    await ended();
  });
});
