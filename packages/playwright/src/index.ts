import { applyCookies, cookieChanges, expiredCdpCookie, toCdpCookie } from '@agent-computers/apply';
import { type Capture, type CapturedCookie, captureSchema, siteOfCookie } from '@agent-computers/capture';
import type { BrowserContext } from 'playwright-core';

// What was last applied to a browser context: pass it to the next applyCapture so only what changed is written, and
// the context keeps cookies it refreshed itself. Keep it private: it holds the session cookies.
export type Applied = { completedAt: string; cookies: CapturedCookie[]; sites: string[] };

// Applies a capture to a Chromium browser context over CDP. Without `previous`, every synced site is replaced
// wholesale; with it, only cookies the user's browser added, changed, or deleted since are written, and sites the user
// signed out of are cleared. Sites only ever touched in this context are left alone. Other contexts are not touched.
export async function applyCapture(context: BrowserContext, capture: Capture, previous?: Applied | null) {
  const changes = cookieChanges(previous?.cookies ?? null, capture.cookies, previous?.sites ?? [], capture.completedAt);
  const page = await context.newPage();
  try {
    // Storage commands act on Chrome's default browser context unless given another's ID, which only a browser-level
    // session accepts. A persistent context is the default one, and has no Browser to open that session from.
    const pageSession = await context.newCDPSession(page);
    const { targetInfo } = await pageSession.send('Target.getTargetInfo');
    const browser = context.browser();
    const session = browser ? await browser.newBrowserCDPSession() : pageSession;
    const send = (method: string, params: Record<string, unknown>) =>
      // biome-ignore lint/suspicious/noExplicitAny: CDP methods are typed per name; applyCookies sends Storage.* only.
      session.send(method as any, params);
    const result = await applyCookies(send, {
      browserContextId: browser ? targetInfo.browserContextId : undefined,
      clearSites: changes.clearSites,
      cookies: [...changes.set.map(toCdpCookie), ...changes.remove.map(expiredCdpCookie)],
    });
    await Promise.all([session.detach(), session === pageSession ? undefined : pageSession.detach()]);
    const applied: Applied = {
      completedAt: capture.completedAt,
      cookies: capture.cookies,
      sites: [...new Set(capture.cookies.map(siteOfCookie))].sort(),
    };
    return { ...result, applied };
  } finally {
    await page.close();
  }
}

// Reading captures from an Agent Computers server with an organization API key (`ack_…`), made by an owner or admin
// on its Organization page. `server` is its origin, such as https://www.agent-computers.com. Pass `fetch` to use your
// own. Errors carry the server's error code as `code`: unauthenticated (a wrong or revoked key), insufficient_scope,
// not_found (no such member in the key's organization), no_capture (the member hasn't synced yet).
export type ServerOptions = { server: string; apiKey: string; fetch?: typeof fetch };
export class CaptureRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Agent Computers answered ${status} ${code}`);
  }
}
async function get(options: ServerOptions, path: string) {
  const response = await (options.fetch ?? fetch)(new URL(`/api/v1${path}`, options.server), {
    headers: { authorization: `Bearer ${options.apiKey}` },
  });
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok)
    throw new CaptureRequestError(response.status, typeof body.error === 'string' ? body.error : 'error');
  return body;
}
// The key's organization's members, with when each last synced; null for one who hasn't.
export async function listMembers(options: ServerOptions) {
  const { members } = (await get(options, '/members')) as {
    members: { id: string; name: string; email: string; role: string; lastSyncedAt: string | null }[];
  };
  return members;
}
// A member's latest capture, checked against the capture format. Needs a key with the captures scope.
export async function fetchCapture(options: ServerOptions & { member: string }): Promise<Capture> {
  const { capture } = (await get(options, `/members/${encodeURIComponent(options.member)}/capture`)) as {
    capture: unknown;
  };
  return captureSchema.parse(capture);
}
