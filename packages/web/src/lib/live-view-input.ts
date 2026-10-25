// Keyboard and clipboard handling for live view that noVNC lacks: on macOS noVNC sends
// left Cmd as Alt, so Cmd shortcuts do nothing on the computer, and noVNC moves clipboard text one byte per character.

// X keysyms (noVNC exports only its RFB client, so they are defined here). ASCII keysyms equal their code points.
export const XK_CONTROL_L = 0xffe3;
export const XK_SHIFT_L = 0xffe1;
const XK_HOME = 0xff50;
const XK_END = 0xff57;

// Like noVNC's own isMac/isIOS (core/util/browser.js), so both agree on which keys mean what.
export const isMac = (platform: string) => /mac|iphone|ipad|ipod/i.test(platform);

export type KeyEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;
// What the page does with a keydown while in control:
// pass: noVNC sends it as usual.
// local: hidden from noVNC, so the browser keeps it (Cmd+R, Cmd+W, zoom) and the computer never sees Cmd.
// paste: hidden from noVNC without preventDefault, so the browser fires paste with this device's clipboard.
// send: preventDefault, and the page sends keysym as a whole chord with the modifiers named.
export type KeyAction =
  | { kind: 'pass' }
  | { kind: 'local' }
  | { kind: 'paste'; shift: boolean }
  | { kind: 'send'; keysym: number; ctrl: boolean; shift: boolean };

// Cmd shortcuts on macOS that mean the same as Ctrl ones on the computer's Chrome (Shift+Z redoes there).
const AS_CTRL = new Set(['a', 'c', 'x', 'z', 'f', 'l']);
// Cmd+arrows move to the line's or the document's ends on macOS; left alone, Cmd+Left is the browser's Back.
const NAV: Record<string, { keysym: number; ctrl: boolean }> = {
  ArrowLeft: { keysym: XK_HOME, ctrl: false },
  ArrowRight: { keysym: XK_END, ctrl: false },
  ArrowUp: { keysym: XK_HOME, ctrl: true },
  ArrowDown: { keysym: XK_END, ctrl: true },
};

export function keyAction(event: KeyEventLike, mac: boolean): KeyAction {
  if (mac && event.key === 'Meta') return { kind: 'local' };
  const key = letter(event) ?? event.key;
  const pasteChord = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (key === 'v' && pasteChord && !event.altKey) return { kind: 'paste', shift: event.shiftKey };
  if (!mac || !event.metaKey) return { kind: 'pass' };
  if (event.ctrlKey || event.altKey) return { kind: 'local' };
  if (AS_CTRL.has(key))
    return { kind: 'send', keysym: keysymOf(key, event.shiftKey), ctrl: true, shift: event.shiftKey };
  const nav = NAV[key];
  if (nav) return { kind: 'send', ...nav, shift: event.shiftKey };
  return { kind: 'local' };
}

// The Latin letter a key means: the one it types, or else the one at its place on a US layout, so shortcuts work on
// layouts like Russian, as they do in Chrome.
function letter({ key, code }: KeyEventLike) {
  if (/^[a-z]$/i.test(key)) return key.toLowerCase();
  return /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : null;
}

// x11vnc adjusts Shift to match the keysym it is given, so a shifted letter must be sent as the capital.
export const keysymOf = (letter: string, shift: boolean) => (shift ? letter.toUpperCase() : letter).charCodeAt(0);

export type KeyStroke = [keysym: number, code: string | null, down: boolean];

// The strokes that press keysym with the modifiers given, releasing whatever they press. A modifier noVNC already
// holds down on the computer (held: the codes of the keys the user holds that noVNC sent) is left to noVNC, so its
// own release still matches and the user's held key stays down.
export function chord(keysym: number, mods: { ctrl: boolean; shift: boolean }, held: ReadonlySet<string>): KeyStroke[] {
  const press: KeyStroke[] = [];
  if (mods.ctrl && !held.has('ControlLeft') && !held.has('ControlRight'))
    press.push([XK_CONTROL_L, 'ControlLeft', true]);
  if (mods.shift && !held.has('ShiftLeft') && !held.has('ShiftRight')) press.push([XK_SHIFT_L, 'ShiftLeft', true]);
  const release = press.map(([sym, code]): KeyStroke => [sym, code, false]).reverse();
  return [...press, [keysym, null, true], [keysym, null, false], ...release];
}

// The modifier keys whose holding chord() needs to know.
export const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight']);

// noVNC hands over the computer's clipboard text one character per byte, but the computer's VNC server sends the
// UTF-8 it got from Chrome. Decodes it, keeping the text as it came if it is not valid UTF-8.
export function decodeCutText(text: string) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) return text;
    bytes[i] = code;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return text;
  }
}

// Keeps the computer's keys in the order the user pressed them while a paste waits on our server: steps run one at a
// time, and while one runs, a keydown waits behind it as a step too, with its keyup, so text typed after Cmd+V lands
// after the pasted text. A step that throws drops those behind it and goes to fail. A keyup whose keydown already
// reached noVNC never waits: releasing early can't leave a key held.
export function keyQueue(fail: (error: unknown) => void) {
  const steps: (() => unknown)[] = [];
  // Keydowns waiting, by code, so their keyups wait too.
  const waiting = new Map<string, number>();
  let running = false;
  const drop = () => {
    steps.length = 0;
    waiting.clear();
  };
  const drain = async () => {
    running = true;
    while (steps.length) {
      const step = steps.shift()!;
      try {
        await step();
      } catch (error) {
        drop();
        fail(error);
      }
    }
    running = false;
  };
  const push = (step: () => unknown) => {
    steps.push(step);
    if (!running) void drain();
  };
  return {
    busy: () => running,
    // Runs step after the steps before it, at once when none waits.
    push,
    // Whether a key event must wait (queuing replay for its turn) rather than reach noVNC now.
    hold(type: 'keydown' | 'keyup', code: string, replay: () => void) {
      if (type === 'keydown') {
        if (!running) return false;
        waiting.set(code, (waiting.get(code) ?? 0) + 1);
        push(() => {
          const left = (waiting.get(code) ?? 1) - 1;
          if (left) waiting.set(code, left);
          else waiting.delete(code);
          replay();
        });
        return true;
      }
      if (!waiting.has(code)) return false;
      push(replay);
      return true;
    },
    drop,
  };
}
