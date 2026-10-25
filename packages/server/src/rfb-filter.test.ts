import { describe, expect, it } from 'vitest';
import { MAX_CUT_TEXT, MAX_FRAME, RfbClientFilter } from './rfb-filter';

// --- Message builders (big-endian, as noVNC 1.7.0 sends them) ---

const bytes = (...values: number[]) => Uint8Array.from(values);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
};
const message = (length: number, write: (view: DataView) => void) => {
  const out = new Uint8Array(length);
  write(new DataView(out.buffer));
  return out;
};

const handshake = join(new TextEncoder().encode('RFB 003.008\n'), bytes(1), bytes(1));
const setPixelFormat = (bpp = 32, bigEndian = 0, trueColour = 1) =>
  message(20, v => {
    v.setUint8(0, 0);
    v.setUint8(4, bpp);
    v.setUint8(5, 24);
    v.setUint8(6, bigEndian);
    v.setUint8(7, trueColour);
    v.setUint16(8, 255);
    v.setUint16(10, 255);
    v.setUint16(12, 255);
    v.setUint8(14, 16);
    v.setUint8(15, 8);
    v.setUint8(16, 0);
  });
const setEncodings = (encodings: number[]) =>
  message(4 + 4 * encodings.length, v => {
    v.setUint8(0, 2);
    v.setUint16(2, encodings.length);
    for (const [i, encoding] of encodings.entries()) v.setInt32(4 + 4 * i, encoding | 0);
  });
const updateRequest = (incremental = 1) =>
  message(10, v => {
    v.setUint8(0, 3);
    v.setUint8(1, incremental);
    v.setUint16(6, 1280);
    v.setUint16(8, 800);
  });
const continuousUpdates = (enable = 1) =>
  message(10, v => {
    v.setUint8(0, 150);
    v.setUint8(1, enable);
    v.setUint16(6, 1280);
    v.setUint16(8, 800);
  });
const fence = (payload: number) =>
  message(9 + payload, v => {
    v.setUint8(0, 248);
    v.setUint32(4, 0x80000003);
    v.setUint8(8, payload);
  });
const keyEvent = (keysym: number, down: number) =>
  message(8, v => {
    v.setUint8(0, 4);
    v.setUint8(1, down);
    v.setUint32(4, keysym);
  });
const pointerEvent = (mask: number, x: number, y: number) =>
  message(6, v => {
    v.setUint8(0, 5);
    v.setUint8(1, mask);
    v.setUint16(2, x);
    v.setUint16(4, y);
  });
const cutText = (text: Uint8Array) =>
  join(
    message(8, v => {
      v.setUint8(0, 6);
      v.setUint32(4, text.length);
    }),
    text,
  );
// Extended clipboard: the length is negative, and the payload starts with a 4-byte flags field.
const extendedCutText = (payload: Uint8Array) =>
  join(
    message(8, v => {
      v.setUint8(0, 6);
      v.setInt32(4, -payload.length);
    }),
    payload,
  );
const cutTextHeader = (declared: number) =>
  message(8, v => {
    v.setUint8(0, 6);
    v.setUint32(4, declared);
  });
const setDesktopSize = (screens: number) =>
  message(8 + 16 * screens, v => {
    v.setUint8(0, 251);
    v.setUint16(2, 1920);
    v.setUint16(4, 1080);
    v.setUint8(6, screens);
  });
const qemuKey = (keysym: number, keycode: number, down: number, sub = 0) =>
  message(12, v => {
    v.setUint8(0, 255);
    v.setUint8(1, sub);
    v.setUint16(2, down);
    v.setUint32(4, keysym);
    v.setUint32(8, keycode);
  });

// noVNC 1.7.0's SetEncodings list (rfb.js _sendEncodings), H.264 included.
const NOVNC_ENCODINGS = [
  1, 50, 7, -260, 16, 21, 5, 2, 6, 0, -26, -254, -223, -224, -258, -261, -308, -309, -312, -313, -307, 0xc0a1e5ce, -316,
  0x574d5664, -239,
];

const SHIFT = 0xffe1;
const A = 0x61;

const ready = (control = false) => {
  const filter = new RfbClientFilter();
  expect(filter.push(handshake, control)).toEqual({ forward: handshake });
  return filter;
};

// Splits `data` at random points into frames no larger than MAX_FRAME.
function randomSplits(data: Uint8Array, random: () => number): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let o = 0;
  while (o < data.length) {
    const size = Math.min(data.length - o, 1 + Math.floor(random() * 40));
    frames.push(data.subarray(o, o + size));
    o += size;
  }
  return frames;
}

function feed(filter: RfbClientFilter, frames: Uint8Array[], control: boolean) {
  const out: Uint8Array[] = [];
  let close: string | undefined;
  for (const frame of frames) {
    const result = filter.push(frame, control);
    out.push(result.forward);
    if (result.close) {
      close = result.close;
      break;
    }
  }
  return { forward: join(...out), close };
}

// Deterministic PRNG, so a failing property case reproduces.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('RfbClientFilter handshake', () => {
  it('forwards the noVNC handshake the same however it is split, without control', () => {
    const whole = new RfbClientFilter().push(handshake, false);
    expect(whole).toEqual({ forward: handshake });
    expect(
      feed(
        new RfbClientFilter(),
        [...handshake].map(b => bytes(b)),
        false,
      ),
    ).toEqual({
      forward: handshake,
      close: undefined,
    });
    const random = mulberry32(1);
    for (let i = 0; i < 20; i++) {
      expect(feed(new RfbClientFilter(), randomSplits(handshake, random), false).forward).toEqual(handshake);
    }
  });

  it.each([['RFB 003.003\n'], ['RFB 003.007\n'], ['RFB 003.889\n'], ['GET / HTTP/1.1'], [`ID:${'1'.repeat(246)}`]])(
    'closes on version %j',
    version => {
      const result = new RfbClientFilter().push(new TextEncoder().encode(version), true);
      expect(result).toEqual({ forward: new Uint8Array(0), close: 'version' });
    },
  );

  it.each([[2], [0]])('closes on security type %i', type => {
    const result = new RfbClientFilter().push(join(handshake.subarray(0, 12), bytes(type)), true);
    expect(result.close).toBe('security type');
    expect(result.forward).toEqual(handshake.subarray(0, 12));
  });

  it('closes on an exclusive ClientInit', () => {
    expect(new RfbClientFilter().push(join(handshake.subarray(0, 13), bytes(0)), true).close).toBe('client init');
  });
});

describe('RfbClientFilter messages', () => {
  it("forwards a watcher's framebuffer messages byte-identical", () => {
    const filter = ready();
    for (const msg of [
      setPixelFormat(),
      setPixelFormat(16, 1),
      updateRequest(0),
      continuousUpdates(),
      fence(0),
      fence(64),
    ]) {
      expect(filter.push(msg, false)).toEqual({ forward: msg });
    }
  });

  it('strips ExtendedMouseButtons and Xvp from noVNC SetEncodings, keeping the rest in order', () => {
    const result = ready().push(setEncodings(NOVNC_ENCODINGS), false);
    expect(result).toEqual({ forward: setEncodings(NOVNC_ENCODINGS.filter(e => e !== -316 && e !== -309)) });
    expect(new DataView(result.forward.buffer).getUint16(2)).toBe(23);
    expect(new DataView(result.forward.buffer).getUint32(4 + 4 * 20)).toBe(0xc0a1e5ce);
  });

  it.each([[0], [65]])('closes SetEncodings with %i encodings', count => {
    expect(ready().push(setEncodings(Array.from({ length: count }, () => 0)), false).close).toBe('type 2');
  });

  const inputs = (): [string, Uint8Array][] => [
    ['KeyEvent', keyEvent(A, 1)],
    ['PointerEvent', pointerEvent(1, 10, 20)],
    ['ClientCutText', cutText(new TextEncoder().encode('secret'))],
    ['extended clipboard caps', extendedCutText(bytes(0x01, 0, 0, 0x1f, 0, 0, 0x10, 0))],
    ['QEMU extended key', qemuKey(A, 30, 1)],
  ];

  it.each(inputs())("drops a watcher's %s and keeps parsing after it", (_, input) => {
    const after = updateRequest();
    expect(ready().push(join(input, after), false)).toEqual({ forward: after, droppedInput: true });
  });

  it.each(inputs())("forwards a controller's %s byte-identical", (_, input) => {
    expect(ready(true).push(input, true)).toEqual({ forward: input });
  });

  it('never forwards SetDesktopSize, even with control, and keeps parsing after it', () => {
    const after = updateRequest();
    expect(ready(true).push(join(setDesktopSize(1), after), true)).toEqual({ forward: after });
    expect(ready().push(join(setDesktopSize(16), after), false)).toEqual({ forward: after });
  });

  it.each<[string, Uint8Array]>([
    ['PointerEvent with the extended-buttons bit', pointerEvent(0x80, 0, 0)],
    ['KeyEvent with down 2', keyEvent(A, 2)],
    ['plain cut text over 1 MiB, from its header alone', cutTextHeader(MAX_CUT_TEXT + 1)],
    ['cut text with length 0x80000000', cutTextHeader(0x80000000)],
    ['extended cut text of 3 bytes', extendedCutText(bytes(1, 2, 3))],
    ['fence with a 65-byte payload', fence(65).subarray(0, 9)],
    ['SetDesktopSize with no screens', setDesktopSize(0)],
    ['SetDesktopSize with 17 screens', setDesktopSize(17).subarray(0, 8)],
    ['QEMU audio', qemuKey(0, 0, 0, 1).subarray(0, 2)],
    ['QEMU key with down 2', qemuKey(A, 30, 2)],
    ['SetPixelFormat with 24 bpp', setPixelFormat(24)],
    ['SetPixelFormat with a colour map', setPixelFormat(32, 0, 0)],
    ['FramebufferUpdateRequest with incremental 2', updateRequest(2)],
  ])('closes on %s, with or without control', (_, msg) => {
    for (const control of [false, true]) {
      const result = ready(control).push(msg, control);
      expect(result.close).toMatch(/^type \d+$/);
      expect(result.forward).toEqual(new Uint8Array(0));
    }
  });

  it('accepts empty cut text and a 64-byte fence', () => {
    expect(ready(true).push(cutText(new Uint8Array(0)), true)).toEqual({ forward: cutText(new Uint8Array(0)) });
    expect(ready().push(fence(64), false)).toEqual({ forward: fence(64) });
  });

  it('closes on every message type off the allowlist, including xvp and file transfer', () => {
    const allowed = new Set([0, 2, 3, 4, 5, 6, 150, 248, 251, 255]);
    for (let type = 0; type < 256; type++) {
      if (allowed.has(type)) continue;
      const result = ready(true).push(bytes(type, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), true);
      expect(result).toEqual({ forward: new Uint8Array(0), close: `type ${type}` });
    }
  });

  it('forwards the messages before a violation in the same frame, then closes', () => {
    const result = ready().push(join(updateRequest(), bytes(250, 0, 0, 0)), false);
    expect(result).toEqual({ forward: updateRequest(), close: 'type 250' });
  });
});

describe('RfbClientFilter framing', () => {
  it('parses a message split mid-header and many messages in one frame', () => {
    const filter = ready();
    const encodings = setEncodings([0, 1, 7]);
    expect(filter.push(encodings.subarray(0, 3), false)).toEqual({ forward: new Uint8Array(0) });
    expect(filter.push(encodings.subarray(3, 9), false)).toEqual({ forward: new Uint8Array(0) });
    expect(filter.push(encodings.subarray(9), false)).toEqual({ forward: encodings });
    const many = join(...Array.from({ length: 200 }, () => updateRequest()));
    expect(filter.push(many, false)).toEqual({ forward: many });
  });

  it('drops a 1 MiB cut text in 10 KiB frames for a watcher, and forwards it whole to a controller', () => {
    const text = new Uint8Array(MAX_CUT_TEXT).fill(0x41);
    const msg = cutText(text);
    const frames: Uint8Array[] = [];
    for (let o = 0; o < msg.length; o += 10 * 1024) frames.push(msg.subarray(o, o + 10 * 1024));
    expect(feed(ready(), frames, false)).toEqual({ forward: new Uint8Array(0), close: undefined });
    expect(feed(ready(true), frames, true)).toEqual({ forward: msg, close: undefined });
  });

  it('closes on a frame above 64 KiB', () => {
    expect(ready().push(new Uint8Array(MAX_FRAME + 1), false)).toEqual({
      forward: new Uint8Array(0),
      close: 'frame too large',
    });
  });

  it('forwards nothing after closing', () => {
    const filter = ready();
    expect(filter.push(bytes(1), false).close).toBe('type 1');
    expect(filter.closed).toBe(true);
    expect(filter.push(updateRequest(), true)).toEqual({ forward: new Uint8Array(0), close: 'closed' });
    expect(filter.setControl(false)).toEqual(new Uint8Array(0));
  });
});

describe('RfbClientFilter control', () => {
  it('decides on input when the message completes', () => {
    const filter = ready();
    const key = keyEvent(A, 1);
    expect(filter.push(key.subarray(0, 4), false)).toEqual({ forward: new Uint8Array(0) });
    expect(filter.push(key.subarray(4), true)).toEqual({ forward: key });
    const release = keyEvent(A, 0);
    const pointer = pointerEvent(0, 5, 5);
    expect(filter.push(join(pointer, release.subarray(0, 2)), true)).toEqual({ forward: pointer });
    // Losing control releases the key held so far, and the key-up completed after is dropped.
    expect(filter.push(release.subarray(2), false)).toEqual({ forward: release, droppedInput: true });
  });

  it('releases held keys and buttons when control ends', () => {
    const filter = ready(true);
    const input = join(keyEvent(SHIFT, 1), keyEvent(A, 1), pointerEvent(1, 300, 200), qemuKey(0x62, 48, 1));
    expect(filter.push(input, true)).toEqual({ forward: input });
    expect(filter.setControl(false)).toEqual(
      join(keyEvent(SHIFT, 0), keyEvent(A, 0), qemuKey(0x62, 48, 0), pointerEvent(0, 300, 200)),
    );
    // Everything was released, so regaining and losing control again sends nothing.
    filter.setControl(true);
    expect(filter.setControl(false)).toEqual(new Uint8Array(0));
  });

  it('releases on close while in control', () => {
    const filter = ready(true);
    filter.push(join(keyEvent(A, 1), pointerEvent(4, 1, 2)), true);
    expect(filter.release()).toEqual(join(keyEvent(A, 0), pointerEvent(0, 1, 2)));
    expect(filter.closed).toBe(true);
  });

  it('releases before closing on a violation while in control', () => {
    const filter = ready(true);
    filter.push(keyEvent(A, 1), true);
    expect(filter.push(bytes(250, 0, 0, 0), true)).toEqual({ forward: keyEvent(A, 0), close: 'type 250' });
  });

  it('sends no releases when nothing was held', () => {
    const filter = ready(true);
    filter.push(join(keyEvent(A, 1), keyEvent(A, 0), pointerEvent(1, 3, 3), pointerEvent(0, 3, 3)), true);
    expect(filter.setControl(false)).toEqual(new Uint8Array(0));
    expect(ready(true).release()).toEqual(new Uint8Array(0));
  });

  it('closes when too many keys are held at once', () => {
    const filter = ready(true);
    const keys = join(...Array.from({ length: 257 }, (_, i) => keyEvent(0x1000 + i, 1)));
    const result = filter.push(keys, true);
    expect(result.close).toBe('too many keys down');
    // The 256 keys that did go upstream are released.
    expect(result.forward.length).toBe(2 * 256 * 8);
  });
});

// --- Property test ---

// An independent reference splitter: message types in a stream the filter forwarded, after the handshake.
function forwardedTypes(stream: Uint8Array): number[] {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const types: number[] = [];
  let o = handshake.length;
  while (o < stream.length) {
    const type = stream[o] as number;
    types.push(type);
    const lengths: Record<number, () => number> = {
      0: () => 20,
      2: () => 4 + 4 * view.getUint16(o + 2),
      3: () => 10,
      4: () => 8,
      5: () => 6,
      6: () => 8 + Math.abs(view.getInt32(o + 4)),
      150: () => 10,
      248: () => 9 + (stream[o + 8] as number),
      251: () => 8 + 16 * (stream[o + 6] as number),
      255: () => 12,
    };
    const length = lengths[type];
    if (!length) throw new Error(`forwarded unknown type ${type}`);
    o += length();
  }
  if (o !== stream.length) throw new Error('forwarded a partial message');
  return types;
}

function randomMessage(random: () => number): Uint8Array {
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)] as T;
  const noise = () => Uint8Array.from({ length: 1 + Math.floor(random() * 12) }, () => Math.floor(random() * 256));
  return pick<() => Uint8Array>([
    () => setPixelFormat(),
    () => setEncodings(NOVNC_ENCODINGS),
    () => updateRequest(Math.floor(random() * 2)),
    () => continuousUpdates(),
    () => fence(Math.floor(random() * 65)),
    () => keyEvent(Math.floor(random() * 0xffff), Math.floor(random() * 2)),
    () => pointerEvent(Math.floor(random() * 8), 1, 1),
    () => cutText(noise()),
    () => extendedCutText(new Uint8Array(4 + Math.floor(random() * 20))),
    () => setDesktopSize(1 + Math.floor(random() * 2)),
    () => qemuKey(A, 1 + Math.floor(random() * 100), Math.floor(random() * 2)),
    // Rarely, raw noise: usually a violation, sometimes a valid-looking message.
    () => (random() < 0.1 ? noise() : updateRequest()),
  ])();
}

describe('RfbClientFilter property', () => {
  it('never forwards input without control, and splitting never changes the result', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = mulberry32(seed);
      const stream = join(
        handshake,
        ...Array.from({ length: 1 + Math.floor(random() * 40) }, () => randomMessage(random)),
      );
      const whole = feed(new RfbClientFilter(), [stream], false);
      const split = feed(new RfbClientFilter(), randomSplits(stream, random), false);
      expect(split, `seed ${seed}`).toEqual(whole);
      const types = forwardedTypes(whole.forward);
      for (const type of types) expect([4, 5, 6, 251, 255], `seed ${seed}`).not.toContain(type);

      // With control, the same holds for SetDesktopSize, and splitting still changes nothing.
      const controlled = feed(new RfbClientFilter(), [stream], true);
      expect(feed(new RfbClientFilter(), randomSplits(stream, random), true), `seed ${seed}`).toEqual(controlled);
      expect(forwardedTypes(controlled.forward), `seed ${seed}`).not.toContain(251);
    }
  });

  it('closes or stays consistent on pure noise after the handshake', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = mulberry32(seed + 1000);
      const noise = Uint8Array.from({ length: 1 + Math.floor(random() * 200) }, () => Math.floor(random() * 256));
      const stream = join(handshake, noise);
      const whole = feed(new RfbClientFilter(), [stream], false);
      expect(feed(new RfbClientFilter(), randomSplits(stream, random), false), `seed ${seed}`).toEqual(whole);
      for (const type of forwardedTypes(whole.forward)) expect([4, 5, 6, 251, 255]).not.toContain(type);
    }
  });
});
