import type { SessionHandle } from '@agent-computers/server/computers';
import { describe, expect, it } from 'vitest';
import { browserAction, missingInput, SNAPSHOT } from './browser';

const PAGE = 'A'.repeat(32);
const OTHER = 'B'.repeat(32);
const page = {
  url: 'https://mail.test/',
  title: 'Inbox',
  snapshot: '- textbox "Search mail" [ref=e1]',
  truncated: false,
};

// A computer session whose CDP answers come from `reply`, recording the commands and desktop actions.
function sessionWith(reply: (method: string, params: Record<string, unknown>, target?: string) => unknown) {
  const commands: { method: string; params: Record<string, unknown>; target?: string | undefined }[] = [];
  const actions: unknown[] = [];
  const session = {
    cdp: async ({
      method,
      params = {},
      targetId,
    }: {
      method: string;
      params?: Record<string, unknown>;
      targetId?: string;
    }) => {
      commands.push({ method, params, target: targetId });
      return JSON.stringify(reply(method, params, targetId));
    },
    act: async (action: unknown) => {
      actions.push(action);
    },
  } as unknown as SessionHandle['session'];
  return { session, commands, actions };
}
// What the page answers: a snapshot, its load state, or `element` for a function run on a ref's element.
const evaluated = (expression: string, element: unknown) => {
  if (expression.startsWith(SNAPSHOT)) return { result: { result: { value: page } } };
  if (expression === 'document.readyState') return { result: { result: { value: 'complete' } } };
  if (expression === 'document.visibilityState') return { result: { result: { value: 'hidden' } } };
  return { result: { result: { value: element } } };
};
// A browser with one tab, whose elements answer with `element`.
const browser = (
  element: unknown = { value: { x: 320, y: 240 } },
  overrides: (method: string, params: Record<string, unknown>) => unknown = () => undefined,
) =>
  sessionWith((method, params) => {
    const overridden = overrides(method, params);
    if (overridden !== undefined) return overridden;
    if (method === 'Target.getTargets')
      return { result: { targetInfos: [{ targetId: PAGE, type: 'page', url: page.url, title: page.title }] } };
    if (method === 'Runtime.evaluate') return evaluated(String(params.expression), element);
    return { result: {} };
  });
const far = () => Date.now() + 60_000;

describe('browser actions', () => {
  it('reads the page in itself, in one command', () => {
    expect(() => new Function(`return ${SNAPSHOT}`)).not.toThrow();
  });
  it('snapshots the tab on screen and names it', async () => {
    const { session, commands } = browser();
    const { truncated: _, ...shown } = page;
    expect(await browserAction(session, { action: 'snapshot' }, far())).toEqual({ target_id: PAGE, ...shown });
    expect(commands.map(command => command.method)).toEqual(['Target.getTargets', 'Runtime.evaluate']);
  });
  it('picks the visible tab among several, else the first page', async () => {
    const { session } = browser(undefined, method =>
      method === 'Target.getTargets'
        ? {
            result: {
              targetInfos: [
                { targetId: 'C'.repeat(32), type: 'service_worker', url: 'https://b.test/sw.js', title: '' },
                { targetId: OTHER, type: 'page', url: 'https://a.test/', title: 'A' },
                { targetId: PAGE, type: 'page', url: 'https://b.test/', title: 'B' },
              ],
            },
          }
        : undefined,
    );
    expect(await browserAction(session, { action: 'snapshot' }, far())).toMatchObject({ target_id: OTHER });
  });
  it('clicks an element with the desktop mouse at its center, then reads the page again', async () => {
    const { session, commands, actions } = browser();
    const after = await browserAction(session, { action: 'click', ref: 'e12' }, far());
    expect(actions).toEqual([{ type: 'click', x: 320, y: 240, button: 'left', double: false }]);
    const found = commands.find(command => String(command.params.expression).includes('"e12"'));
    expect(found).toMatchObject({ method: 'Runtime.evaluate', target: PAGE });
    expect(after).toMatchObject({ target_id: PAGE, snapshot: page.snapshot });
  });
  it('tells the agent a ref is stale once its page changed', async () => {
    const { session, actions } = browser({ stale: true });
    await expect(browserAction(session, { action: 'click', ref: 'e999' }, far())).rejects.toMatchObject({
      code: 'stale_ref',
    });
    expect(actions).toEqual([]);
  });
  it("won't click what isn't on the page", async () => {
    const { session, actions } = browser({ value: null });
    await expect(browserAction(session, { action: 'click', ref: 'e12' }, far())).rejects.toMatchObject({
      code: 'not_visible',
    });
    expect(actions).toEqual([]);
  });
  it('types into a field, replacing what it held, and presses Enter to submit', async () => {
    const { session, commands, actions } = browser({ value: true });
    await browserAction(session, { action: 'type', ref: 'e1', text: 'receipts', submit: true }, far());
    expect(commands.find(command => command.method === 'Input.insertText')).toMatchObject({
      params: { text: 'receipts' },
      target: PAGE,
    });
    expect(commands.find(command => command.method === 'Input.dispatchKeyEvent')).toMatchObject({
      params: { type: 'keyDown', key: 'Enter', text: '\r' },
      target: PAGE,
    });
    expect(actions).toEqual([]);
  });
  it('reports a failed navigation and an unknown tab as errors the agent can act on', async () => {
    const failed = browser(undefined, method =>
      method === 'Page.navigate' ? { result: { errorText: 'net::ERR_NAME_NOT_RESOLVED' } } : undefined,
    );
    await expect(
      browserAction(failed.session, { action: 'navigate', url: 'https://nowhere.test/' }, far()),
    ).rejects.toMatchObject({ code: 'navigation_failed', message: 'net::ERR_NAME_NOT_RESOLVED' });
    const closed = browser(undefined, method =>
      method === 'Runtime.evaluate' ? { error: 'cdp_connection_failed' } : undefined,
    );
    await expect(browserAction(closed.session, { action: 'snapshot', target_id: OTHER }, far())).rejects.toMatchObject({
      code: 'tab_not_found',
    });
  });
  it('names what an action is missing', () => {
    expect(missingInput({ action: 'type', ref: 'e1' })).toEqual(['text']);
    expect(missingInput({ action: 'snapshot' })).toBeUndefined();
  });
});
