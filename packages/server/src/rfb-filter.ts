// The live-view relay's view-only enforcement: it parses what the browser's noVNC sends to the
// computer's VNC server and forwards only what the connection may send. Watching needs the handshake and a
// few framebuffer messages; keyboard, pointer, and clipboard go through only while the user holds a live
// takeover; any message it does not know, or that does not match what noVNC 1.7.0 sends, closes the
// connection. Only the client-to-server stream is parsed, so every message length must be decidable without
// server state; stripping ExtendedMouseButtons from SetEncodings keeps PointerEvent at 6 bytes. Sources:
// RFC 6143 and rfbproto (https://github.com/rfbproto/rfbproto/blob/152107d/rfbproto.rst), checked against
// noVNC 1.7.0's core/rfb.js and libvncserver's rfbserver.c.
//
// These limits bound the protocol, not time, so they live here rather than in computer-timing.ts.

// noVNC flushes its send queue at 10 KiB, so no honest frame comes close.
export const MAX_FRAME = 64 * 1024;
// noVNC sends 25 encodings.
export const MAX_ENCODINGS = 64;
// libvncserver closes on a larger ClientCutText (CVE-2018-7225), so nothing bigger is useful.
export const MAX_CUT_TEXT = 1024 * 1024;
// At most one incomplete message is buffered, and the largest is a ClientCutText.
export const MAX_PENDING = 8 + MAX_CUT_TEXT;
// rfbproto caps a fence's payload at 64 bytes.
const MAX_FENCE = 64;
// noVNC sends one screen; libvncserver accepts up to 16 anyway.
const MAX_SCREENS = 16;
// Keys held at once; a real keyboard never comes close, and the bound keeps the release list small.
const MAX_KEYS_DOWN = 256;

// WebSocket close code for a policy violation, which the relay sends the browser when `close` is set.
export const RFB_FILTER_CLOSE_CODE = 1008;

const VERSION = new TextEncoder().encode('RFB 003.008\n');
// ExtendedMouseButtons (-316) would make PointerEvent 7 bytes once the server acknowledges it; Xvp (-309)
// would let the client shut down, reboot, or reset the computer.
const STRIPPED_ENCODINGS = new Set([-316 >>> 0, -309 >>> 0]);

export type RfbFilterResult = {
  // Whole messages to write upstream, in order. Empty when nothing is to be sent.
  forward: Uint8Array;
  // Set when the connection must close (send RFB_FILTER_CLOSE_CODE to the browser and close upstream). A fixed
  // reason naming at most a message type number; never the bytes.
  close?: string;
  // An input message was dropped for lack of control, so the relay may re-read control sooner.
  droppedInput?: true;
};

type Step = { need: true } | { error: string } | { length: number; forward: Uint8Array | null; dropped?: boolean };

const NEED: Step = { need: true };
const EMPTY = new Uint8Array(0);

// One per relay connection. Feed it every binary frame the browser sends with whether the user holds a live
// takeover right now; call setControl when that changes between frames, and release when the connection ends.
export class RfbClientFilter {
  private state: 'version' | 'security' | 'init' | 'normal' | 'closed' = 'version';
  private buffer = new Uint8Array(4096);
  private start = 0;
  private end = 0;
  private control = false;
  // Keys pressed through KeyEvent, by keysym, and through QEMU extended key events, by keycode and keysym.
  private readonly keysDown = new Set<number>();
  private readonly qemuKeysDown = new Map<string, [keysym: number, keycode: number]>();
  private pointer = { x: 0, y: 0, mask: 0 };

  get closed(): boolean {
    return this.state === 'closed';
  }

  push(chunk: Uint8Array, canControl: boolean): RfbFilterResult {
    if (this.state === 'closed') return { forward: EMPTY, close: 'closed' };
    const out: Uint8Array[] = [];
    const released = this.setControl(canControl);
    if (released.length > 0) out.push(released);
    if (chunk.length > MAX_FRAME) return this.fail('frame too large', out);
    this.append(chunk);
    let dropped = false;
    for (;;) {
      const step = this.next();
      if ('need' in step) break;
      if ('error' in step) return this.fail(step.error, out);
      if (step.forward) out.push(step.forward);
      if (step.dropped) dropped = true;
      this.start += step.length;
    }
    if (this.start === this.end) {
      this.start = this.end = 0;
      // Let a large clipboard's buffer go once it has been handled.
      if (this.buffer.length > MAX_FRAME) this.buffer = new Uint8Array(4096);
    }
    if (this.end - this.start > MAX_PENDING) return this.fail('message too large', out);
    const result: RfbFilterResult = { forward: concat(out) };
    if (dropped) result.droppedInput = true;
    return result;
  }

  // Sets whether input may pass, returning the key and button releases to write upstream when control ends so
  // nothing stays held on the computer.
  setControl(canControl: boolean): Uint8Array {
    const released = this.control && !canControl ? this.releaseInput() : EMPTY;
    this.control = canControl;
    return released;
  }

  // Ends the filter when the connection closes, returning the releases to write upstream before closing it.
  release(): Uint8Array {
    const released = this.setControl(false);
    this.state = 'closed';
    this.buffer = EMPTY;
    this.start = this.end = 0;
    return released;
  }

  private fail(reason: string, out: Uint8Array[]): RfbFilterResult {
    const released = this.release();
    if (released.length > 0) out.push(released);
    return { forward: concat(out), close: reason };
  }

  private append(chunk: Uint8Array): void {
    if (this.end + chunk.length > this.buffer.length) {
      const pending = this.end - this.start;
      const needed = pending + chunk.length;
      if (needed > this.buffer.length) {
        const grown = new Uint8Array(Math.max(needed, this.buffer.length * 2));
        grown.set(this.buffer.subarray(this.start, this.end));
        this.buffer = grown;
      } else this.buffer.copyWithin(0, this.start, this.end);
      this.start = 0;
      this.end = pending;
    }
    this.buffer.set(chunk, this.end);
    this.end += chunk.length;
  }

  private next(): Step {
    const b = this.buffer;
    const o = this.start;
    const available = this.end - o;
    const copy = (length: number) => b.slice(o, o + length);
    switch (this.state) {
      case 'version':
        // Exactly 3.8: x11vnc offers it and noVNC never asks for less. A repeater ID closes here too.
        if (available < VERSION.length) return NEED;
        for (let i = 0; i < VERSION.length; i++) if (b[o + i] !== VERSION[i]) return { error: 'version' };
        this.state = 'security';
        return { length: VERSION.length, forward: copy(VERSION.length) };
      case 'security':
        // None, matching x11vnc -nopw; the relay is the authentication.
        if (available < 1) return NEED;
        if (b[o] !== 1) return { error: 'security type' };
        this.state = 'init';
        return { length: 1, forward: copy(1) };
      case 'init':
        // Shared, so a watcher cannot disconnect the computer's other viewers.
        if (available < 1) return NEED;
        if (b[o] !== 1) return { error: 'client init' };
        this.state = 'normal';
        return { length: 1, forward: copy(1) };
      case 'closed':
        return NEED;
    }
    if (available < 1) return NEED;
    const type = b[o] as number;
    const input = (length: number, track: () => string | undefined): Step => {
      if (!this.control) return { length, forward: null, dropped: true };
      const error = track();
      return error ? { error } : { length, forward: copy(length) };
    };
    switch (type) {
      case 0: {
        // SetPixelFormat: noVNC only handles true colour.
        if (available < 20) return NEED;
        const bpp = b[o + 4];
        if ((bpp !== 8 && bpp !== 16 && bpp !== 32) || (b[o + 6] as number) > 1 || b[o + 7] !== 1) {
          return { error: 'type 0' };
        }
        return { length: 20, forward: copy(20) };
      }
      case 2: {
        // SetEncodings, re-emitted without the stripped encodings.
        if (available < 4) return NEED;
        const count = u16(b, o + 2);
        if (count < 1 || count > MAX_ENCODINGS) return { error: 'type 2' };
        const length = 4 + 4 * count;
        if (available < length) return NEED;
        const kept: number[] = [];
        for (let i = 0; i < count; i++) {
          const encoding = u32(b, o + 4 + 4 * i);
          if (!STRIPPED_ENCODINGS.has(encoding)) kept.push(encoding);
        }
        const forward = new Uint8Array(4 + 4 * kept.length);
        const view = new DataView(forward.buffer);
        forward[0] = 2;
        view.setUint16(2, kept.length);
        for (const [i, encoding] of kept.entries()) view.setUint32(4 + 4 * i, encoding);
        return { length, forward };
      }
      case 3:
      case 150:
        // FramebufferUpdateRequest (incremental flag) and EnableContinuousUpdates (enable flag).
        if (available < 10) return NEED;
        if ((b[o + 1] as number) > 1) return { error: `type ${type}` };
        return { length: 10, forward: copy(10) };
      case 248: {
        // ClientFence, a reply to the server's fence.
        if (available < 9) return NEED;
        const payload = b[o + 8] as number;
        if (payload > MAX_FENCE) return { error: 'type 248' };
        const length = 9 + payload;
        if (available < length) return NEED;
        return { length, forward: copy(length) };
      }
      case 4: {
        // KeyEvent.
        if (available < 8) return NEED;
        const down = b[o + 1] as number;
        if (down > 1) return { error: 'type 4' };
        return input(8, () => {
          const keysym = u32(b, o + 4);
          if (!down) this.keysDown.delete(keysym);
          else if (!this.keysDown.has(keysym)) {
            if (this.keysHeld() >= MAX_KEYS_DOWN) return 'too many keys down';
            this.keysDown.add(keysym);
          }
          return undefined;
        });
      }
      case 5: {
        // PointerEvent; bit 7 would mean the 7-byte ExtendedMouseButtons form, which is never negotiated.
        if (available < 6) return NEED;
        const mask = b[o + 1] as number;
        if (mask & 0x80) return { error: 'type 5' };
        return input(6, () => {
          this.pointer = { x: u16(b, o + 2), y: u16(b, o + 4), mask };
          return undefined;
        });
      }
      case 6: {
        // ClientCutText, plain or (negative length) extended clipboard. Its size is checked from the header so
        // nothing oversized is buffered.
        if (available < 8) return NEED;
        const declared = u32(b, o + 4);
        const extended = declared >= 0x80000000;
        const size = extended ? 2 ** 32 - declared : declared;
        if (size > MAX_CUT_TEXT || (extended && size < 4)) return { error: 'type 6' };
        const length = 8 + size;
        if (available < length) return NEED;
        return input(length, () => undefined);
      }
      case 251: {
        // SetDesktopSize: never forwarded, even with control, since agents rely on the computer's fixed
        // resolution. Parsed so the stream stays in step; the page sets resizeSession = false anyway.
        if (available < 8) return NEED;
        const screens = b[o + 6] as number;
        if (screens < 1 || screens > MAX_SCREENS) return { error: 'type 251' };
        const length = 8 + 16 * screens;
        if (available < length) return NEED;
        return { length, forward: null };
      }
      case 255: {
        // QEMU client message; only subtype 0, the extended key event, is allowed.
        if (available < 2) return NEED;
        if (b[o + 1] !== 0) return { error: 'type 255' };
        if (available < 12) return NEED;
        const down = u16(b, o + 2);
        if (down > 1) return { error: 'type 255' };
        return input(12, () => {
          const keysym = u32(b, o + 4);
          const keycode = u32(b, o + 8);
          const key = `${keycode}:${keysym}`;
          if (!down) this.qemuKeysDown.delete(key);
          else if (!this.qemuKeysDown.has(key)) {
            if (this.keysHeld() >= MAX_KEYS_DOWN) return 'too many keys down';
            this.qemuKeysDown.set(key, [keysym, keycode]);
          }
          return undefined;
        });
      }
      default:
        return { error: `type ${type}` };
    }
  }

  private keysHeld(): number {
    return this.keysDown.size + this.qemuKeysDown.size;
  }

  // Key-ups for every key held, then a pointer event with no buttons at the last position.
  private releaseInput(): Uint8Array {
    const pressedButtons = this.pointer.mask !== 0;
    const out = new Uint8Array(8 * this.keysDown.size + 12 * this.qemuKeysDown.size + (pressedButtons ? 6 : 0));
    const view = new DataView(out.buffer);
    let o = 0;
    for (const keysym of this.keysDown) {
      out[o] = 4;
      view.setUint32(o + 4, keysym);
      o += 8;
    }
    for (const [keysym, keycode] of this.qemuKeysDown.values()) {
      out[o] = 255;
      view.setUint32(o + 4, keysym);
      view.setUint32(o + 8, keycode);
      o += 12;
    }
    if (pressedButtons) {
      out[o] = 5;
      view.setUint16(o + 2, this.pointer.x);
      view.setUint16(o + 4, this.pointer.y);
    }
    this.keysDown.clear();
    this.qemuKeysDown.clear();
    this.pointer = { ...this.pointer, mask: 0 };
    return out;
  }
}

function u16(b: Uint8Array, o: number): number {
  return ((b[o] as number) << 8) | (b[o + 1] as number);
}

function u32(b: Uint8Array, o: number): number {
  return (
    (((b[o] as number) << 24) | ((b[o + 1] as number) << 16) | ((b[o + 2] as number) << 8) | (b[o + 3] as number)) >>> 0
  );
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 0) return EMPTY;
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}
