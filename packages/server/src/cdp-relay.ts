import 'server-only';
import type { RawData, WebSocket } from 'ws';
import { CDP_ACCESS_RECHECK_MS, CDP_CLOSE_MARGIN_MS, CDP_CLOSE_WAIT_MS, CDP_PING_MS } from './computer-timing';
import { errorLabel } from './log';
import { shutdownSignal } from './shutdown';

// The CDP proxy's pipe: it joins a developer's CDP client (Playwright, browser-use, Stagehand) to the fork's Chrome,
// through the computer's CDP bridge, message for message both ways. The relay ends once the computer session may no
// longer use the computer (access), or just before the platform's limit.

// Close codes the client sees. 4000 asks it to reconnect right away (the platform's limit is near); 4001 that the
// computer session ended (closed, idle, replaced, or its API key lost the computers scope), so a new one is needed;
// 4002 that the user took control in live view, so it reconnects once they hand back. The others are drops.
export const CDP_CLOSE = {
  reconnect: 4000,
  sessionEnded: 4001,
  userInControl: 4002,
  computerClosed: 1001,
  error: 1011,
} as const;

// Pause the sending side once this much waits to go out on the other, and resume once below LOW_WATER, so a slow
// client slows Chrome's events instead of filling the function's memory. Bytes: a few full-page screenshots.
const HIGH_WATER = 16 * 1024 * 1024;
const LOW_WATER = 2 * 1024 * 1024;

// Where the connection's computer session stands (computers.ts, computerSessionState).
export type CdpAccess = 'open' | 'user_in_control' | 'ended';
export type CdpRelayEndCause = 'client' | 'computer' | 'deadline' | 'shutdown' | 'error' | 'access';

// What the relay logs: its own fixed words and numbers, never messages, URLs, tokens, or a peer's close reason.
export type CdpRelayLog =
  | { event: 'cdp.relay_end'; cause: CdpRelayEndCause; code?: number; durationMs: number }
  | { event: 'cdp.relay_error'; side: 'client' | 'computer' | 'access'; error: string };

export type CdpRelayOptions = {
  // The upgraded socket from the developer's client.
  client: WebSocket;
  // An open socket to Chrome's browser endpoint, through the computer's bridge.
  upstream: WebSocket;
  // Whether the computer session may go on, read from the database. A rejection counts as open, so a failed read never
  // ends a connection; the next one decides.
  access: () => Promise<CdpAccess>;
  // When the platform cuts the connection, in `now()` milliseconds; the relay closes with 4000 'reconnect'
  // CDP_CLOSE_MARGIN_MS before it.
  deadlineMs: number;
  // Aborted when the server shuts down (shutdown.ts); the relay then closes with 4000 'reconnect' at once.
  stop?: AbortSignal;
  now?: () => number;
  log?: (entry: CdpRelayLog) => void;
};

const OPEN = 1;
const CLOSED = 3;

// Runs one relay connection. Resolves once both sockets have closed; it never rejects.
export function cdpRelay({
  client,
  upstream,
  access,
  deadlineMs,
  stop = shutdownSignal,
  now = Date.now,
  log = entry => console.log(JSON.stringify(entry)),
}: CdpRelayOptions): Promise<void> {
  const started = now();
  let ended = false;
  let reading = false;
  let terminateTimer: ReturnType<typeof setTimeout> | undefined;
  client.binaryType = 'nodebuffer';
  upstream.binaryType = 'nodebuffer';

  // Sends on `to`, pausing `from` while `to` is backed up.
  const pipe = (data: RawData, binary: boolean, to: WebSocket, from: WebSocket) => {
    to.send(data, { binary }, () => {
      if (from.isPaused && to.bufferedAmount < LOW_WATER) from.resume();
    });
    if (to.bufferedAmount > HIGH_WATER && !from.isPaused) from.pause();
  };

  const readAccess = async () => {
    if (reading || ended) return;
    reading = true;
    let value: CdpAccess = 'open';
    try {
      value = await access();
    } catch (error) {
      log({ event: 'cdp.relay_error', side: 'access', error: errorLabel(error) });
    }
    reading = false;
    if (value === 'ended') end('access', CDP_CLOSE.sessionEnded, 'session ended');
    else if (value === 'user_in_control') end('access', CDP_CLOSE.userInControl, 'user in control');
  };

  const accessTimer = setInterval(() => void readAccess(), CDP_ACCESS_RECHECK_MS);
  const pingTimer = setInterval(() => {
    for (const socket of [client, upstream]) if (socket.readyState === OPEN) socket.ping();
  }, CDP_PING_MS);
  const deadlineTimer = setTimeout(
    () => end('deadline', CDP_CLOSE.reconnect, 'reconnect'),
    Math.max(0, deadlineMs - CDP_CLOSE_MARGIN_MS - now()),
  );
  const onStop = () => end('shutdown', CDP_CLOSE.reconnect, 'reconnect');
  // A connection that arrives while the server is already shutting down closes as soon as it starts.
  if (stop.aborted) queueMicrotask(onStop);
  else stop.addEventListener('abort', onStop, { once: true });

  const closed = new Promise<void>(resolve => {
    let open = 2;
    const onClosed = () => {
      open -= 1;
      if (open > 0) return;
      clearTimeout(terminateTimer);
      resolve();
    };
    for (const socket of [client, upstream]) {
      if (socket.readyState === CLOSED) onClosed();
      else socket.once('close', onClosed);
    }
  });

  // Ends the relay once, closing both sockets.
  function end(cause: CdpRelayEndCause, code: number, reason: string, peerCode?: number) {
    if (ended) return;
    ended = true;
    clearInterval(accessTimer);
    clearInterval(pingTimer);
    clearTimeout(deadlineTimer);
    stop.removeEventListener('abort', onStop);
    for (const [socket, closeCode, closeReason] of [
      [upstream, 1000, ''],
      [client, code, reason],
    ] as const) {
      if (socket.readyState !== CLOSED) socket.close(closeCode, closeReason);
    }
    terminateTimer = setTimeout(() => {
      client.terminate();
      upstream.terminate();
    }, CDP_CLOSE_WAIT_MS);
    // Never what keeps the process alive: it only matters while a socket is still open.
    terminateTimer.unref();
    const entry: CdpRelayLog = { event: 'cdp.relay_end', cause, durationMs: now() - started };
    if (peerCode !== undefined) entry.code = peerCode;
    log(entry);
  }

  client.on('message', (data, isBinary) => {
    if (!ended && upstream.readyState === OPEN) pipe(data, isBinary, upstream, client);
  });
  upstream.on('message', (data, isBinary) => {
    if (!ended && client.readyState === OPEN) pipe(data, isBinary, client, upstream);
  });
  client.on('close', code => end('client', CDP_CLOSE.computerClosed, '', code));
  upstream.on('close', code => end('computer', CDP_CLOSE.computerClosed, 'computer closed', code));
  client.on('error', error => {
    log({ event: 'cdp.relay_error', side: 'client', error: errorLabel(error) });
    end('error', CDP_CLOSE.error, 'error');
  });
  upstream.on('error', error => {
    log({ event: 'cdp.relay_error', side: 'computer', error: errorLabel(error) });
    end('error', CDP_CLOSE.error, 'error');
  });

  if (upstream.readyState !== OPEN) end('computer', CDP_CLOSE.error, 'computer closed');
  else if (client.readyState !== OPEN) end('client', CDP_CLOSE.computerClosed, '');
  return closed;
}
