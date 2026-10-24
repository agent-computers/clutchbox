import { applyCookies, cookieChanges, expiredCdpCookie, toCdpCookie } from '@agent-computers/apply';
import { type Capture, type CapturedCookie, captureSchema, siteOfCookie } from '@agent-computers/capture';
import type { BrowserContext } from 'playwright-core';

// What was last applied to a browser context: pass it to the next applyCapture so only what changed is written, and
// the context keeps cookies it refreshed itself. Keep it private: it holds the session cookies.
export type Applied = { completedAt: string; cookies: CapturedCookie[]; sites: string[] };

// The latest capture from an Agent Computers server (such as the self-host server), or null
// when there is none yet.
export async function fetchCapture({
  server,
  apiKey,
  fetcher = fetch,
}: {
  server: string;
  apiKey: string;
  fetcher?: typeof fetch;
}): Promise<Capture | null> {
  const response = await fetcher(new URL('/api/v1/capture', server), {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not fetch the capture: ${response.status}`);
  const body = (await response.json()) as { capture: unknown };
  return captureSchema.parse(body.capture);
}

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
