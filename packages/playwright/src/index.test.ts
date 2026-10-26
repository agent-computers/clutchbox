import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Capture, CapturedCookie } from '@agent-computers/capture';
import { type Browser, chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyCapture } from './index';

// Synthetic cookies only; no real browser data.
const cookie = (overrides: Partial<CapturedCookie> = {}): CapturedCookie => ({
  name: 'sid',
  value: 'host',
  domain: 'github.com',
  hostOnly: true,
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  session: false,
  expirationDate: 2_000_000_000,
  storeId: '0',
  ...overrides,
});
const capture = (cookies: CapturedCookie[]): Capture => ({
  schemaVersion: 2,
  id: randomUUID(),
  scope: { mode: 'sites', sites: ['github.com', 'notion.so'], excludedDomains: [] },
  startedAt: new Date(Date.now() - 1000).toISOString(),
  completedAt: new Date().toISOString(),
  consistency: 'non-atomic-cookie-read',
  coverage: 'cookies-only',
  storeId: '0',
  cookies,
});
const held = (domain: string, name: string, value: string) => ({
  name,
  value,
  domain,
  path: '/',
  secure: true,
  httpOnly: false,
  sameSite: 'Lax' as const,
  expires: 2_000_000_000,
});

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(() => browser.close());

describe('applying a capture to a Playwright context', () => {
  it('replaces synced sites wholesale at first, keeps other sites, and never touches other contexts', async () => {
    const context = await browser.newContext();
    const other = await browser.newContext();
    await context.addCookies([held('github.com', 'stale', 'old'), held('a.test', 'mine', 'keep')]);
    await other.addCookies([held('github.com', 'theirs', 'keep')]);
    const result = await applyCapture(
      context,
      capture([cookie(), cookie({ domain: '.notion.so', hostOnly: false, name: 'token' })]),
    );
    expect(result).toMatchObject({ cleared: 1, set: 2, failed: 0 });
    const jar = (await context.cookies()).map(c => `${c.domain}:${c.name}=${c.value}`).sort();
    expect(jar).toEqual(['.notion.so:token=host', 'a.test:mine=keep', 'github.com:sid=host']);
    expect((await other.cookies()).map(c => c.name)).toEqual(['theirs']);
    // Host-only stays host-only: Chrome marks a domain cookie with a leading dot.
    expect((await context.cookies()).find(c => c.name === 'sid')?.domain).toBe('github.com');
    await Promise.all([context.close(), other.close()]);
  });
  it('then writes only what changed on the host, and clears a site the user signed out of', async () => {
    const context = await browser.newContext();
    const first = await applyCapture(
      context,
      capture([cookie(), cookie({ domain: 'notion.so', name: 'token', value: 'host' })]),
    );
    // The context refreshes its own notion.so cookie; the host changes only github.com's.
    await context.addCookies([held('notion.so', 'token', 'refreshed here')]);
    const second = await applyCapture(
      context,
      capture([cookie({ value: 'new' }), cookie({ domain: 'notion.so', name: 'token', value: 'host' })]),
      first.applied,
    );
    expect(second).toMatchObject({ cleared: 0, set: 1 });
    const values = Object.fromEntries((await context.cookies()).map(c => [c.domain, c.value]));
    expect(values).toEqual({ 'github.com': 'new', 'notion.so': 'refreshed here' });
    // Signed out of github.com on the host: its cookies leave the capture, and the site is cleared here.
    await applyCapture(
      context,
      capture([cookie({ domain: 'notion.so', name: 'token', value: 'host' })]),
      second.applied,
    );
    expect((await context.cookies()).map(c => c.domain)).toEqual(['notion.so']);
    await context.close();
  });
});

describe('a persistent context', () => {
  it('is applied to as well, through its own pages', async () => {
    const context = await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(), 'apply-')));
    await context.addCookies([held('github.com', 'stale', 'old')]);
    expect(await applyCapture(context, capture([cookie()]))).toMatchObject({ cleared: 1, set: 1 });
    expect((await context.cookies()).map(c => `${c.name}=${c.value}`)).toEqual(['sid=host']);
    await context.close();
  });
});

describe('a running Chrome attached over CDP', () => {
  it('is applied to through its default context, as for agents that share its CDP URL', async () => {
    const port = 9300 + Math.floor(Math.random() * 500);
    const chrome = spawn(chromium.executablePath(), [
      '--headless=new',
      // As Playwright launches it: CI runners (Ubuntu 24.04) block the sandbox's user namespaces.
      '--no-sandbox',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${await mkdtemp(path.join(tmpdir(), 'cdp-'))}`,
      'about:blank',
    ]);
    try {
      let attached: Browser | undefined;
      for (let i = 0; !attached && i < 200; i++)
        attached = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
          return undefined;
        });
      const context = attached!.contexts()[0]!;
      await context.addCookies([held('github.com', 'stale', 'old')]);
      expect(await applyCapture(context, capture([cookie()]))).toMatchObject({ cleared: 1, set: 1 });
      expect((await context.cookies()).map(c => `${c.name}=${c.value}`)).toEqual(['sid=host']);
      await attached!.close();
    } finally {
      chrome.kill();
    }
  });
});
