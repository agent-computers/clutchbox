import { describe, expect, it } from 'vitest';
import {
  chord,
  decodeCutText,
  type KeyEventLike,
  keyAction,
  keyQueue,
  pastedContent,
  XK_CONTROL_L,
  XK_SHIFT_L,
} from './live-view-input';

const key = (key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});
const cmd = (k: string, mods: Partial<KeyEventLike> = {}) => key(k, { metaKey: true, ...mods });
const ctrl = (k: string, mods: Partial<KeyEventLike> = {}) => key(k, { ctrlKey: true, ...mods });

describe('keyAction on macOS', () => {
  it('hides Cmd itself from noVNC, which would send it as Alt', () => {
    expect(keyAction(key('Meta', { metaKey: true, code: 'MetaLeft' }), true)).toEqual({ kind: 'local' });
  });

  it('lets the browser paste on Cmd+V and Cmd+Shift+V', () => {
    expect(keyAction(cmd('v'), true)).toEqual({ kind: 'paste', shift: false });
    expect(keyAction(cmd('V', { shiftKey: true }), true)).toEqual({ kind: 'paste', shift: true });
  });

  it('sends editing shortcuts as Ctrl chords, with the capital when Shift is held', () => {
    for (const letter of ['a', 'c', 'x', 'z', 'f', 'l'])
      expect(keyAction(cmd(letter), true)).toEqual({
        kind: 'send',
        keysym: letter.charCodeAt(0),
        ctrl: true,
        shift: false,
      });
    expect(keyAction(cmd('z', { shiftKey: true }), true)).toEqual({
      kind: 'send',
      keysym: 0x5a,
      ctrl: true,
      shift: true,
    });
  });

  it('maps by key position on layouts without Latin letters', () => {
    expect(keyAction(cmd('с', { code: 'KeyC' }), true)).toMatchObject({ kind: 'send', keysym: 0x63 });
    expect(keyAction(cmd('м', { code: 'KeyV' }), true)).toEqual({ kind: 'paste', shift: false });
  });

  it('sends Cmd+arrows as Home and End, and Ctrl+Home and Ctrl+End', () => {
    expect(keyAction(cmd('ArrowLeft'), true)).toEqual({ kind: 'send', keysym: 0xff50, ctrl: false, shift: false });
    expect(keyAction(cmd('ArrowRight', { shiftKey: true }), true)).toEqual({
      kind: 'send',
      keysym: 0xff57,
      ctrl: false,
      shift: true,
    });
    expect(keyAction(cmd('ArrowUp'), true)).toEqual({ kind: 'send', keysym: 0xff50, ctrl: true, shift: false });
    expect(keyAction(cmd('ArrowDown'), true)).toEqual({ kind: 'send', keysym: 0xff57, ctrl: true, shift: false });
  });

  it('leaves other Cmd chords to the browser and keeps them from the computer', () => {
    for (const event of [cmd('r'), cmd('w'), cmd('1'), cmd('='), cmd('['), cmd('Shift', { shiftKey: true })])
      expect(keyAction(event, true)).toEqual({ kind: 'local' });
    expect(keyAction(cmd('c', { altKey: true }), true)).toEqual({ kind: 'local' });
    expect(keyAction(cmd('v', { ctrlKey: true }), true)).toEqual({ kind: 'local' });
  });

  it('passes keys without Cmd, Ctrl+V included, to noVNC', () => {
    expect(keyAction(key('a'), true)).toEqual({ kind: 'pass' });
    expect(keyAction(ctrl('v'), true)).toEqual({ kind: 'pass' });
    expect(keyAction(key('Control', { ctrlKey: true, code: 'ControlLeft' }), true)).toEqual({ kind: 'pass' });
  });
});

describe('keyAction elsewhere', () => {
  it('lets the browser paste on Ctrl+V and Ctrl+Shift+V', () => {
    expect(keyAction(ctrl('v'), false)).toEqual({ kind: 'paste', shift: false });
    expect(keyAction(ctrl('V', { shiftKey: true }), false)).toEqual({ kind: 'paste', shift: true });
  });

  it('passes every other key to noVNC unchanged', () => {
    for (const event of [ctrl('c'), ctrl('z'), ctrl('v', { altKey: true }), cmd('v'), key('Meta'), key('v')])
      expect(keyAction(event, false)).toEqual({ kind: 'pass' });
  });
});

describe('chord', () => {
  const none = new Set<string>();

  it('presses the modifiers around the key and releases them in reverse', () => {
    expect(chord(0x5a, { ctrl: true, shift: true }, none)).toEqual([
      [XK_CONTROL_L, 'ControlLeft', true],
      [XK_SHIFT_L, 'ShiftLeft', true],
      [0x5a, null, true],
      [0x5a, null, false],
      [XK_SHIFT_L, 'ShiftLeft', false],
      [XK_CONTROL_L, 'ControlLeft', false],
    ]);
    expect(chord(0xff50, { ctrl: false, shift: false }, none)).toEqual([
      [0xff50, null, true],
      [0xff50, null, false],
    ]);
  });

  it('leaves a modifier the user holds through noVNC alone', () => {
    expect(chord(0x76, { ctrl: true, shift: false }, new Set(['ControlRight']))).toEqual([
      [0x76, null, true],
      [0x76, null, false],
    ]);
    expect(chord(0x56, { ctrl: true, shift: true }, new Set(['ShiftLeft']))).toEqual([
      [XK_CONTROL_L, 'ControlLeft', true],
      [0x56, null, true],
      [0x56, null, false],
      [XK_CONTROL_L, 'ControlLeft', false],
    ]);
  });
});

describe('decodeCutText', () => {
  const asBytes = (text: string) => String.fromCharCode(...new TextEncoder().encode(text));

  it('decodes the UTF-8 the computer sends, one byte per character', () => {
    for (const text of ['plain ascii', 'café “quoted” — 日本語 ✓ 🙂']) expect(decodeCutText(asBytes(text))).toBe(text);
  });

  it('keeps text that is not UTF-8 as it came', () => {
    expect(decodeCutText('caf\xe9')).toBe('caf\xe9');
    expect(decodeCutText('already 日本')).toBe('already 日本');
    expect(decodeCutText('')).toBe('');
  });
});

describe('keyQueue', () => {
  // A paste step that finishes when the test says, and the keys the computer got, in order.
  const setup = () => {
    const sent: string[] = [];
    const failed: unknown[] = [];
    const queue = keyQueue(error => failed.push(error));
    let finish!: (ok: boolean) => void;
    const paste = () =>
      queue.push(() =>
        new Promise<void>((resolve, reject) => {
          finish = ok => (ok ? resolve() : reject(new Error('paste failed')));
        }).then(() => sent.push('paste')),
      );
    // A key event reaches noVNC now unless the queue holds it.
    const key = (type: 'keydown' | 'keyup', code: string) => {
      const stroke = `${code} ${type === 'keydown' ? 'down' : 'up'}`;
      if (!queue.hold(type, code, () => sent.push(stroke))) sent.push(stroke);
    };
    const settle = () => new Promise(resolve => setTimeout(resolve));
    return { queue, sent, failed, paste, key, finish: (ok: boolean) => finish(ok), settle };
  };

  it('passes keys straight through while no paste runs', () => {
    const { queue, sent, key } = setup();
    key('keydown', 'KeyA');
    key('keyup', 'KeyA');
    expect(sent).toEqual(['KeyA down', 'KeyA up']);
    expect(queue.busy()).toBe(false);
  });

  it('sends keys typed during a paste after it, in order, then passes keys again', async () => {
    const { queue, sent, paste, key, finish, settle } = setup();
    paste();
    key('keydown', 'Enter');
    key('keyup', 'Enter');
    key('keydown', 'KeyA');
    key('keydown', 'KeyA');
    expect(sent).toEqual([]);
    finish(true);
    await settle();
    expect(sent).toEqual(['paste', 'Enter down', 'Enter up', 'KeyA down', 'KeyA down']);
    expect(queue.busy()).toBe(false);
    key('keyup', 'KeyA');
    expect(sent.at(-1)).toBe('KeyA up');
  });

  it('holds a keyup while its keydown waits, but not one whose keydown already went', async () => {
    const { sent, paste, key, finish, settle } = setup();
    key('keydown', 'ShiftLeft');
    paste();
    key('keydown', 'KeyB');
    key('keydown', 'KeyB');
    key('keyup', 'ShiftLeft');
    expect(sent).toEqual(['ShiftLeft down', 'ShiftLeft up']);
    finish(true);
    await settle();
    key('keyup', 'KeyB');
    expect(sent).toEqual(['ShiftLeft down', 'ShiftLeft up', 'paste', 'KeyB down', 'KeyB down', 'KeyB up']);
  });

  it('drops what waits behind a failed paste, a later paste included', async () => {
    const { queue, sent, failed, paste, key, finish, settle } = setup();
    paste();
    key('keydown', 'KeyC');
    paste();
    key('keydown', 'Enter');
    finish(false);
    await settle();
    expect(sent).toEqual([]);
    expect(failed).toEqual([new Error('paste failed')]);
    expect(queue.busy()).toBe(false);
    // The dropped keys' keyups reach noVNC, which ignores a release it never pressed.
    key('keyup', 'KeyC');
    expect(sent).toEqual(['KeyC up']);
  });
});

describe('pastedContent', () => {
  const entry = (type: string, value: Blob | string | null) => ({ type, read: async () => value });
  const image = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

  it('pastes the text when the clipboard also holds a picture of it, as Word and Excel copy', async () => {
    expect(
      await pastedContent([entry('image/png', image), entry('text/html', '<b>hi</b>'), entry('text/plain', 'hi')]),
    ).toBe('hi');
    // The async Clipboard API hands text over as a Blob.
    expect(await pastedContent([entry('text/plain', new Blob(['日本語'])), entry('image/png', image)])).toBe('日本語');
  });

  it('pastes the image when there is no text, as with a screenshot or an image copied from a page', async () => {
    expect(await pastedContent([entry('image/png', image)])).toBe(image);
    expect(
      await pastedContent([entry('text/plain', ''), entry('text/html', '<img>'), entry('image/jpeg', image)]),
    ).toBe(image);
  });

  it('pastes nothing from a clipboard with neither', async () => {
    expect(await pastedContent([])).toBe('');
    expect(await pastedContent([entry('text/html', '<p></p>'), entry('image/png', null)])).toBe('');
  });
});
