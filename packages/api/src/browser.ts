import 'server-only';
import { BROWSER_LOAD_MS, BROWSER_LOAD_POLL_MS, BROWSER_SETTLE_MS } from '@agent-computers/server/computer-timing';
import type { SessionHandle } from '@agent-computers/server/computers';
import { z } from 'zod';

// The MCP browser tool: page-level control of the computer's Chrome over the session's CDP commands, so an agent reads
// a page as text and acts on its elements by ref instead of through screenshots. Each CDP command on a computer is its
// own short connection, and Chrome's own accessibility tree doesn't answer on one in time, so the page reads itself:
// one Runtime.evaluate walks its DOM (SNAPSHOT) and keeps each ref's element in a page-side map, so a ref lasts while
// its page does and a later action finds it in one command. Clicks go through the desktop's mouse (session.act), as a
// person's would, at the element's place on screen.

type Session = SessionHandle['session'];
export const BROWSER_ACTIONS = [
  'navigate',
  'snapshot',
  'click',
  'type',
  'select',
  'tabs',
  'tab_open',
  'tab_activate',
  'tab_close',
  'evaluate',
  'cdp',
] as const;
const targetId = z
  .string()
  .regex(/^[A-Fa-f0-9]{32}$/)
  .describe('A tab, from target_id in an earlier result or tabs. Omit it for the tab shown on screen.');
export const browserInput = {
  action: z.enum(BROWSER_ACTIONS),
  target_id: targetId.optional(),
  url: z
    .url({ protocol: /^https?$/ })
    .max(4000)
    .optional()
    .describe('For navigate and tab_open.'),
  ref: z
    .string()
    .regex(/^e\d{1,12}$/)
    .optional()
    .describe('For click, type, and select: an element ref, such as e42, from the latest snapshot.'),
  text: z.string().max(2000).optional().describe('For type: replaces what the field holds.'),
  submit: z.boolean().optional().describe('For type: press Enter after typing.'),
  value: z.string().max(500).optional().describe("For select: the option's value or label."),
  expression: z.string().max(8000).optional().describe('For evaluate: JavaScript run in the page; its value returns.'),
  method: z
    .string()
    .regex(/^[A-Z][A-Za-z]+\.[a-zA-Z]+$/)
    .optional()
    .describe('For cdp: a Chrome DevTools Protocol method. Without target_id it goes to the browser, not a tab.'),
  params: z.record(z.string(), z.unknown()).optional().describe('For cdp: its parameters.'),
};
export type BrowserInput = { [Key in keyof typeof browserInput]?: z.infer<(typeof browserInput)[Key]> } & {
  action: (typeof BROWSER_ACTIONS)[number];
};
// What each action needs besides its name, checked before anything runs.
const REQUIRED: Partial<Record<BrowserInput['action'], (keyof BrowserInput)[]>> = {
  navigate: ['url'],
  tab_open: ['url'],
  click: ['ref'],
  type: ['ref', 'text'],
  select: ['ref', 'value'],
  tab_activate: ['target_id'],
  tab_close: ['target_id'],
  evaluate: ['expression'],
  cdp: ['method'],
};
export const missingInput = (input: BrowserInput) => REQUIRED[input.action]?.filter(key => input[key] === undefined);

// The most a snapshot or a returned value may hold, so one result stays readable.
const SNAPSHOT_MAX_CHARS = 30_000;
const RESULT_MAX_CHARS = 60_000;
const NAME_MAX_CHARS = 200;

export class BrowserError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const STALE = new BrowserError(
  'stale_ref',
  'That ref is from an older snapshot, or its page has changed or closed. Take a new snapshot.',
);

type Reply = { result?: Record<string, unknown>; error?: unknown };
async function send(session: Session, method: string, params?: Record<string, unknown>, target?: string) {
  const raw = await session.cdp({ method, params, targetId: target });
  let reply: Reply;
  try {
    reply = JSON.parse(raw || '{"error":"cdp_no_response"}');
  } catch {
    throw new BrowserError(
      'cdp_invalid_response',
      'Chrome returned an unreadable reply. Take a snapshot before repeating an action that may already have run.',
    );
  }
  if (reply.error === undefined) return reply.result ?? {};
  const message =
    typeof reply.error === 'string'
      ? reply.error
      : String((reply.error as { message?: unknown }).message ?? 'CDP error');
  if (target && message === 'cdp_connection_failed')
    throw new BrowserError('tab_not_found', 'No such tab. Call the tabs action for the open tabs.');
  if (/no node|node with given id|backend id|could not find node/i.test(message)) throw STALE;
  throw new BrowserError('cdp_error', message);
}

type TargetInfo = { targetId: string; type: string; url: string; title: string };
async function pages(session: Session) {
  const { targetInfos = [] } = (await send(session, 'Target.getTargets')) as { targetInfos?: TargetInfo[] };
  return targetInfos.filter(target => target.type === 'page' && !/^(devtools|chrome-extension):/.test(target.url));
}
// The tab the call is about: the one named, else the one on screen, else the first.
async function pageOf(session: Session, named?: string) {
  if (named) return named;
  const open = await pages(session);
  if (!open.length) throw new BrowserError('no_tab', 'No tab is open. Use tab_open with a url.');
  if (open.length === 1) return open[0]!.targetId;
  for (const page of open) {
    const shown = await send(
      session,
      'Runtime.evaluate',
      { expression: 'document.visibilityState', returnByValue: true },
      page.targetId,
    ).catch(() => null);
    if ((shown?.result as { value?: unknown } | undefined)?.value === 'visible') return page.targetId;
  }
  return open[0]!.targetId;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Waits for the page to finish loading, up to BROWSER_LOAD_MS or the call's deadline, whichever is sooner.
async function loaded(session: Session, target: string, deadline: number) {
  const until = Math.min(Date.now() + BROWSER_LOAD_MS, deadline - BROWSER_LOAD_POLL_MS);
  while (Date.now() < until) {
    const state = await send(
      session,
      'Runtime.evaluate',
      { expression: 'document.readyState', returnByValue: true },
      target,
    ).catch(() => null);
    if ((state?.result as { value?: unknown } | undefined)?.value === 'complete') return;
    await sleep(BROWSER_LOAD_POLL_MS);
  }
}

// Where the page keeps its refs: element to ref and back, numbered so a ref is never reused for another element.
const STATE = `window[Symbol.for('clutchbox.browser')]`;
// Reads the page as indented lines, one per element worth reading or acting on: its role, name, states, value (never a
// password's), and a ref for those an agent can act on. Hidden elements are left out; layout tables, rows, and cells
// show only through their contents. Runs in the page, given the most characters to return.
export const SNAPSHOT = `(maxChars => {
  const state = (${STATE} ??= { ids: new WeakMap(), refs: new Map(), next: 1 });
  const refOf = el => {
    let ref = state.ids.get(el);
    if (!ref) {
      ref = 'e' + state.next++;
      state.ids.set(el, ref);
      state.refs.set(ref, new WeakRef(el));
    }
    return ref;
  };
  const TAGS = { BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img', NAV: 'navigation',
    MAIN: 'main', FORM: 'form', UL: 'list', OL: 'list', LI: 'listitem', DIALOG: 'dialog', OPTION: 'option',
    SUMMARY: 'button', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', IFRAME: 'iframe' };
  const INPUTS = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button',
    image: 'button', range: 'slider', search: 'searchbox' };
  const ACTIONABLE = new Set(['link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'slider',
    'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'treeitem', 'spinbutton']);
  const FROM_TEXT = new Set(['link', 'button', 'heading', 'option', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'switch', 'treeitem', 'img']);
  const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'slider']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK']);
  const roleOf = el => {
    const aria = el.getAttribute('role');
    if (aria) return aria.split(' ')[0];
    if (el.tagName === 'A') return el.hasAttribute('href') ? 'link' : null;
    if (el.tagName === 'INPUT') return el.type === 'hidden' ? null : INPUTS[el.type] ?? 'textbox';
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    return TAGS[el.tagName] ?? null;
  };
  const clean = text => (text ?? '').replace(/\\s+/g, ' ').trim();
  const clip = text => (text.length > ${NAME_MAX_CHARS} ? text.slice(0, ${NAME_MAX_CHARS}) + '…' : text);
  const nameOf = (el, role) => {
    const label = el.getAttribute('aria-label');
    if (label) return clean(label);
    const by = el.getAttribute('aria-labelledby');
    if (by) return clean(by.split(' ').map(id => document.getElementById(id)?.innerText ?? '').join(' '));
    if (el.labels?.length) return clean([...el.labels].map(label => label.innerText).join(' '));
    const alt = el.getAttribute('alt') ?? el.getAttribute('title') ?? el.getAttribute('placeholder');
    if (alt) return clean(alt);
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value);
    return FROM_TEXT.has(role) ? clean(el.innerText) : '';
  };
  const hidden = el =>
    el.getAttribute('aria-hidden') === 'true' ||
    (el.checkVisibility ? !el.checkVisibility({ visibilityProperty: true }) : getComputedStyle(el).display === 'none');
  const lines = [];
  let length = 0;
  let truncated = false;
  const emit = (depth, line) => {
    const text = '  '.repeat(depth) + line;
    if (length + text.length + 1 > maxChars) return !(truncated = true);
    lines.push(text);
    length += text.length + 1;
    return true;
  };
  const walk = (node, depth) => {
    if (truncated) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = clean(node.textContent);
      if (text) emit(depth, '- text: ' + JSON.stringify(clip(text)));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || SKIP.has(node.tagName) || hidden(node)) return;
    const el = node;
    const role = roleOf(el);
    const actionable =
      (role && ACTIONABLE.has(role)) || (el.tabIndex >= 0 && el.hasAttribute('tabindex')) || el.hasAttribute('onclick');
    let inner = depth;
    if (role || actionable) {
      const name = role ? nameOf(el, role) : clean(el.innerText);
      const states = [];
      if (el.checked === true || el.getAttribute('aria-checked') === 'true') states.push('checked');
      if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') states.push('disabled');
      if (el.getAttribute('aria-expanded') === 'true') states.push('expanded');
      if (el.selected === true || el.getAttribute('aria-selected') === 'true') states.push('selected');
      if (el.required === true) states.push('required');
      if (/^H[1-6]$/.test(el.tagName)) states.push('level=' + el.tagName[1]);
      if (actionable) states.push('ref=' + refOf(el));
      let value = '';
      if (el.tagName === 'SELECT') value = clean(el.selectedOptions[0]?.label);
      else if ((el.tagName === 'INPUT' && el.type !== 'password' && !INPUTS[el.type]) || el.tagName === 'TEXTAREA')
        value = clean(el.value);
      const line =
        '- ' + (role ?? 'generic') +
        (name ? ' ' + JSON.stringify(clip(name)) : '') +
        (states.length ? ' [' + states.join('] [') + ']' : '') +
        (value && value !== name ? ': ' + JSON.stringify(clip(value)) : '');
      if (!emit(depth, line)) return;
      if (((!role || FROM_TEXT.has(role)) && name) || FIELDS.has(role)) return;
      inner = depth + 1;
    }
    for (const child of el.shadowRoot?.childNodes ?? []) walk(child, inner);
    for (const child of el.childNodes) walk(child, inner);
  };
  if (document.body) walk(document.body, 0);
  return { url: location.href, title: document.title, snapshot: lines.join('\\n'), truncated };
})`;

type Snapshot = { url: string; title: string; snapshot: string; truncated: boolean };
async function snapshot(session: Session, target: string) {
  const reply = (await send(
    session,
    'Runtime.evaluate',
    { expression: `${SNAPSHOT}(${SNAPSHOT_MAX_CHARS})`, returnByValue: true },
    target,
  )) as { result?: { value?: Snapshot }; exceptionDetails?: { text?: string } };
  const page = reply.result?.value;
  if (!page) throw new BrowserError('snapshot_failed', reply.exceptionDetails?.text ?? 'The page could not be read.');
  return {
    target_id: target,
    url: page.url,
    title: page.title,
    snapshot: page.snapshot,
    ...(page.truncated
      ? { truncated: true, note: 'The snapshot was cut short. Use evaluate to read a part of the page.' }
      : {}),
  };
}

// Runs a function on the element a ref names, in one command, with its value back.
async function onElement(session: Session, target: string, ref: string, fn: string, args: unknown[] = []) {
  const expression = `(() => {
  const el = ${STATE}?.refs.get(${JSON.stringify(ref)})?.deref();
  if (!el || !el.isConnected) return { stale: true };
  return { value: (${fn}).apply(el, ${JSON.stringify(args)}) };
})()`;
  const reply = (await send(session, 'Runtime.evaluate', { expression, returnByValue: true }, target)) as {
    result?: { value?: { stale?: boolean; value?: unknown } };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (reply.exceptionDetails)
    throw new BrowserError(
      'element_failed',
      reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? 'It failed.',
    );
  if (!reply.result?.value || reply.result.value.stale) throw STALE;
  return reply.result.value.value;
}
// Scrolls the element into view and gives its center in screen pixels, from the window's place on the desktop and the
// browser's own toolbars above the page.
const CENTER = `function () {
  this.scrollIntoView({ block: 'center', inline: 'center' });
  const box = this.getBoundingClientRect();
  if (!box.width && !box.height) return null;
  const scale = window.devicePixelRatio || 1;
  const left = window.screenX + (window.outerWidth - window.innerWidth) / 2;
  const top = window.screenY + window.outerHeight - window.innerHeight;
  return { x: Math.round((left + box.left + box.width / 2) * scale), y: Math.round((top + box.top + box.height / 2) * scale) };
}`;
const FOCUS_AND_CLEAR = `function () {
  this.scrollIntoView({ block: 'center' });
  this.focus();
  if ('select' in this && typeof this.select === 'function') this.select();
  else if (this.isContentEditable) document.execCommand('selectAll');
  return document.activeElement === this || this.contains(document.activeElement);
}`;
const SELECT = `function (wanted) {
  if (!(this instanceof HTMLSelectElement)) return 'not_select';
  const option = [...this.options].find(option => option.value === wanted || option.label.trim() === wanted);
  if (!option) return 'no_option';
  this.value = option.value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return 'selected';
}`;

// Keys go to the page, not the desktop: the page's focused element has them even when Chrome's own focus is elsewhere,
// such as on the address bar. A key down alone, with its text, is enough to submit a form or delete a selection.
const ENTER = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };
const BACKSPACE = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 };
const key = (session: Session, target: string, pressed: Record<string, unknown>) =>
  send(session, 'Input.dispatchKeyEvent', { type: 'keyDown', ...pressed }, target);
// After an action: lets the page react, waits for any load it started, and reads it.
async function settled(session: Session, target: string, deadline: number) {
  await sleep(BROWSER_SETTLE_MS);
  await loaded(session, target, deadline);
  return snapshot(session, target);
}
const capped = (value: unknown) => {
  const text = JSON.stringify(value ?? null);
  if (text.length > RESULT_MAX_CHARS)
    throw new BrowserError('result_too_large', 'The result is too large. Return a smaller value.');
  return value ?? null;
};

// One browser action, with what the agent gets back. Throws BrowserError for what the agent can act on.
export async function browserAction(
  session: Session,
  input: BrowserInput,
  deadline: number,
): Promise<Record<string, unknown>> {
  switch (input.action) {
    case 'tabs':
      return {
        tabs: (await pages(session)).map(page => ({ target_id: page.targetId, url: page.url, title: page.title })),
      };
    case 'tab_open': {
      const { targetId: opened } = (await send(session, 'Target.createTarget', { url: input.url })) as {
        targetId: string;
      };
      await loaded(session, opened, deadline);
      return snapshot(session, opened);
    }
    case 'tab_activate':
      await send(session, 'Target.activateTarget', { targetId: input.target_id });
      return snapshot(session, input.target_id!);
    case 'tab_close':
      await send(session, 'Target.closeTarget', { targetId: input.target_id });
      return {
        closed: input.target_id,
        tabs: (await pages(session)).map(page => ({ target_id: page.targetId, url: page.url, title: page.title })),
      };
    case 'cdp': {
      // Raw, as Chrome answers it: without target_id, to the browser rather than a tab.
      const raw = await session.cdp({ method: input.method!, params: input.params, targetId: input.target_id });
      let reply: unknown;
      try {
        reply = JSON.parse(raw || '{"error":"cdp_no_response"}');
      } catch {
        reply = null;
      }
      if (!reply || typeof reply !== 'object' || Array.isArray(reply))
        throw new BrowserError(
          'cdp_invalid_response',
          'Chrome returned an unreadable reply. Take a snapshot before repeating a command that may already have run.',
        );
      if ('error' in reply) throw new BrowserError('cdp_error', JSON.stringify((reply as { error: unknown }).error));
      return { ...(input.target_id ? { target_id: input.target_id } : {}), result: capped((reply as Reply).result) };
    }
    default:
      break;
  }
  const target = await pageOf(session, input.target_id);
  switch (input.action) {
    case 'snapshot':
      return snapshot(session, target);
    case 'navigate': {
      const navigated = (await send(session, 'Page.navigate', { url: input.url }, target)) as { errorText?: string };
      if (navigated.errorText) throw new BrowserError('navigation_failed', navigated.errorText);
      await loaded(session, target, deadline);
      return snapshot(session, target);
    }
    case 'click': {
      const center = (await onElement(session, target, input.ref!, CENTER)) as { x: number; y: number } | null;
      if (!center || center.x < 0 || center.y < 0)
        throw new BrowserError('not_visible', "That element isn't visible on the page. Take a new snapshot.");
      await session.act({ type: 'click', x: center.x, y: center.y, button: 'left', double: false });
      return settled(session, target, deadline);
    }
    case 'type': {
      if (!(await onElement(session, target, input.ref!, FOCUS_AND_CLEAR)))
        throw new BrowserError('not_editable', "That element can't take typing. Take a new snapshot.");
      if (input.text) await send(session, 'Input.insertText', { text: input.text }, target);
      // Nothing to type: delete what the field held, which is selected.
      else await key(session, target, BACKSPACE);
      if (input.submit) await key(session, target, ENTER);
      return settled(session, target, deadline);
    }
    case 'select': {
      const outcome = await onElement(session, target, input.ref!, SELECT, [input.value]);
      if (outcome === 'not_select') throw new BrowserError('not_select', "That element isn't a select.");
      if (outcome === 'no_option') throw new BrowserError('no_option', 'That select has no such option.');
      return settled(session, target, deadline);
    }
    case 'evaluate': {
      const reply = (await send(
        session,
        'Runtime.evaluate',
        { expression: input.expression, returnByValue: true, awaitPromise: true },
        target,
      )) as {
        result?: { value?: unknown };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
      if (reply.exceptionDetails)
        throw new BrowserError(
          'evaluate_failed',
          reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? 'It threw.',
        );
      return { target_id: target, value: capped(reply.result?.value) };
    }
    default:
      throw new BrowserError('unknown_action', 'Unknown action.');
  }
}
