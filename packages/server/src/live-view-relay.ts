import 'server-only';
import type { RawData, WebSocket } from 'ws';
import {
  HEARTBEAT_MS,
  LIVE_VIEW_CLOSE_MARGIN_MS,
  LIVE_VIEW_CLOSE_WAIT_MS,
  LIVE_VIEW_CONTROL_RECHECK_MS,
  LIVE_VIEW_PING_MS,
} from './computer-timing';
import { errorLabel } from './log';
import { RFB_FILTER_CLOSE_CODE, RfbClientFilter } from './rfb-filter';
import { shutdownSignal } from './shutdown';

// The live-view relay's pipe: it joins the browser's noVNC WebSocket to the computer's websockify
// WebSocket. What the computer sends goes to the browser byte for byte; what the browser sends goes through the
// RFB filter, which passes input only while the user holds a live takeover on this connection's lease. The relay
// ends once the lease holds neither a watch nor the takeover, or the user's sign-in ends.

// Close codes the page sees. 4000 asks it to reconnect right away; 4001 that the lease lost its watch (or the user
// their sign-in), so it reconnects only once its heartbeat shows it watching again; 4002 that the computer must be
// reset first (it accepts public traffic). The others are drops it retries with backoff, except a policy
// violation, which it should not retry.
export const RELAY_CLOSE = {
  reconnect: 4000,
  notWatching: 4001,
  needsReset: 4002,
  policy: RFB_FILTER_CLOSE_CODE,
  computerClosed: 1001,
  error: 1011,
} as const;

// Pause the sending side once this much waits to go out on the other, and resume once below LOW_WATER, so a slow
// browser slows the computer's stream instead of filling the function's memory. Bytes, not time, so they live
// here: a few uncompressed screens of the computer's desktop, 1920x1200 at most.
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;

export type RelayEndCause = 'browser' | 'computer' | 'deadline' | 'shutdown' | 'filter' | 'text' | 'error' | 'access';

// What the relay logs: its own fixed words and numbers, never bytes, URLs, tokens, or a peer's close reason.
export type RelayLog =
  | { event: 'live_view.relay_end'; cause: RelayEndCause; code?: number; reason?: string; durationMs: number }
  | { event: 'live_view.relay_error'; side: 'browser' | 'computer' | 'control'; error: string };

export type RelayOptions = {
  // The upgraded socket from the page.
  browser: WebSocket;
  // An open socket to the computer's websockify.
  upstream: WebSocket;
  // What this connection's lease may do now, read from the database with the user's sign-in: control while it holds
  // the live takeover, view while it holds a live watch, none after both ended. A rejection counts as view (no
  // input), so a failed read never ends the stream.
  access: () => Promise<'control' | 'view' | 'none'>;
  // Called whenever the filter drops input for lack of control.
  onDroppedInput?: () => void;
  // When the platform cuts the connection, in `now()` milliseconds; the relay closes with 4000 'reconnect'
  // LIVE_VIEW_CLOSE_MARGIN_MS before it.
  deadlineMs: number;
  // Aborted when the server shuts down (shutdown.ts); the relay then closes with 4000 'reconnect' at once.
  stop?: AbortSignal;
  now?: () => number;
  log?: (entry: RelayLog) => void;
};

const OPEN = 1;
const CLOSED = 3;

// Runs one relay connection. Resolves once both sockets have closed; it never rejects.
export function relay({
  browser,
  upstream,
  access,
  onDroppedInput,
  deadlineMs,
  stop = shutdownSignal,
  now = Date.now,
  log = entry => console.log(JSON.stringify(entry)),
}: RelayOptions): Promise<void> {
  const started = now();
  const filter = new RfbClientFilter();
  // Fails closed: no input passes until the first read says so.
  let control = false;
  let ended = false;
  let reading = false;
  let lastRead = Number.NEGATIVE_INFINITY;
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;
  let terminateTimer: ReturnType<typeof setTimeout> | undefined;
  browser.binaryType = 'nodebuffer';
  upstream.binaryType = 'nodebuffer';

  const sendUpstream = (bytes: Uint8Array) => {
    if (bytes.length > 0 && upstream.readyState === OPEN) pipe(bytes, true, upstream, browser);
  };

  // Sends on `to`, pausing `from` while `to` is backed up.
  const pipe = (data: RawData | Uint8Array, binary: boolean, to: WebSocket, from: WebSocket) => {
    to.send(data, { binary }, () => {
      if (from.isPaused && to.bufferedAmount < LOW_WATER) from.resume();
    });
    if (to.bufferedAmount > HIGH_WATER && !from.isPaused) from.pause();
  };

  const applyControl = (value: boolean) => {
    control = value;
    sendUpstream(filter.setControl(value));
  };

  const readControl = async () => {
    if (reading || ended) return;
    reading = true;
    lastRead = now();
    let value: 'control' | 'view' | 'none' = 'view';
    try {
      value = await access();
    } catch (error) {
      log({ event: 'live_view.relay_error', side: 'control', error: errorLabel(error) });
    }
    reading = false;
    if (ended) return;
    if (value === 'none') end('access', RELAY_CLOSE.notWatching, 'not watching');
    else applyControl(value === 'control');
  };

  // A re-read sooner than the next heartbeat, at most every LIVE_VIEW_CONTROL_RECHECK_MS.
  const recheckControl = () => {
    if (reading || recheckTimer || ended) return;
    const wait = lastRead + LIVE_VIEW_CONTROL_RECHECK_MS - now();
    if (wait <= 0) {
      void readControl();
      return;
    }
    recheckTimer = setTimeout(() => {
      recheckTimer = undefined;
      void readControl();
    }, wait);
  };

  const controlTimer = setInterval(() => void readControl(), HEARTBEAT_MS);
  const pingTimer = setInterval(() => {
    for (const socket of [browser, upstream]) if (socket.readyState === OPEN) socket.ping();
  }, LIVE_VIEW_PING_MS);
  const deadlineTimer = setTimeout(
    () => end('deadline', RELAY_CLOSE.reconnect, 'reconnect'),
    Math.max(0, deadlineMs - LIVE_VIEW_CLOSE_MARGIN_MS - now()),
  );
  const onStop = () => end('shutdown', RELAY_CLOSE.reconnect, 'reconnect');
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
    for (const socket of [browser, upstream]) {
      if (socket.readyState === CLOSED) onClosed();
      else socket.once('close', onClosed);
    }
  });

  // Ends the relay once: releases held input on the computer, then closes both sockets.
  function end(cause: RelayEndCause, code: number, reason: string, peerCode?: number) {
    if (ended) return;
    ended = true;
    clearInterval(controlTimer);
    clearInterval(pingTimer);
    clearTimeout(deadlineTimer);
    clearTimeout(recheckTimer);
    stop.removeEventListener('abort', onStop);
    sendUpstream(filter.release());
    for (const [socket, closeCode, closeReason] of [
      [upstream, 1000, ''],
      [browser, code, reason],
    ] as const) {
      if (socket.readyState !== CLOSED) socket.close(closeCode, closeReason);
    }
    terminateTimer = setTimeout(() => {
      browser.terminate();
      upstream.terminate();
    }, LIVE_VIEW_CLOSE_WAIT_MS);
    // Never what keeps the process alive: it only matters while a socket is still open.
    terminateTimer.unref();
    const entry: RelayLog = { event: 'live_view.relay_end', cause, durationMs: now() - started };
    if (peerCode !== undefined) entry.code = peerCode;
    if (cause === 'filter') entry.reason = reason;
    log(entry);
  }

  browser.on('message', (data, isBinary) => {
    if (ended) return;
    if (!isBinary) {
      end('text', RELAY_CLOSE.policy, 'binary only');
      return;
    }
    const result = filter.push(toBytes(data), control);
    sendUpstream(result.forward);
    if (result.close) {
      end('filter', RELAY_CLOSE.policy, result.close);
      return;
    }
    if (result.droppedInput) {
      onDroppedInput?.();
      recheckControl();
    }
  });

  upstream.on('message', (data, isBinary) => {
    if (!ended && browser.readyState === OPEN) pipe(data, isBinary, browser, upstream);
  });

  browser.on('close', code => end('browser', RELAY_CLOSE.computerClosed, '', code));
  upstream.on('close', code => end('computer', RELAY_CLOSE.computerClosed, 'computer closed', code));
  browser.on('error', error => {
    log({ event: 'live_view.relay_error', side: 'browser', error: errorLabel(error) });
    end('error', RELAY_CLOSE.error, 'error');
  });
  upstream.on('error', error => {
    log({ event: 'live_view.relay_error', side: 'computer', error: errorLabel(error) });
    end('error', RELAY_CLOSE.error, 'error');
  });

  if (upstream.readyState !== OPEN) end('computer', RELAY_CLOSE.error, 'computer closed');
  else if (browser.readyState !== OPEN) end('browser', RELAY_CLOSE.computerClosed, '');
  else void readControl();
  return closed;
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}
