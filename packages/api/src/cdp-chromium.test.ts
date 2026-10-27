import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CDP_MAX_DURATION_MS } from '../../server/src/computer-timing';
import { useDeveloperApi } from './developer-api-fixtures';

// The CDP proxy in front of a real Chromium, driven by Playwright through a REST computer session's CDP URL
// (developer-api-fixtures.ts). Its own file, since it needs Chromium installed (bunx playwright-core install chromium).
const developer = useDeveloperApi();
const { opened, forkRow } = developer;

describe('the CDP proxy in front of a real Chromium', () => {
  let chrome: ChildProcess;
  let chromeUrl: string;
  beforeAll(async () => {
    const port = 9300 + Math.floor(Math.random() * 500);
    chrome = spawn(chromium.executablePath(), [
      '--headless=new',
      // As Playwright launches it: CI runners (Ubuntu 24.04) block the sandbox's user namespaces.
      '--no-sandbox',
      `--remote-debugging-port=${port}`,
      // The computer's bridge drops the Origin it checks; here the proxy reaches Chrome directly, with it.
      '--remote-allow-origins=agent-computers-relay',
      `--user-data-dir=${await mkdtemp(path.join(tmpdir(), 'cdp-'))}`,
      'about:blank',
    ]);
    for (let i = 0; !chromeUrl && i < 200; i++) {
      const version = await fetch(`http://127.0.0.1:${port}/json/version`)
        .then(response => response.json())
        .catch(() => null);
      if (version) chromeUrl = version.webSocketDebuggerUrl;
      else await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!chromeUrl) throw new Error('Chromium did not start: run bunx playwright-core install chromium');
  });
  afterAll(() => {
    chrome.kill();
  });

  it("lets Playwright drive the fork's Chrome, holding the session while connected, until it is closed", async () => {
    const { session } = await opened();
    developer.fake.setCdpUrl(chromeUrl);
    const browser = await chromium.connectOverCDP(session.cdpUrl);
    const disconnected = new Promise(resolve => browser.once('disconnected', resolve));
    const page = await browser.contexts()[0]!.newPage();
    await page.setContent('<title>On the fork</title>');
    expect(await page.title()).toBe('On the fork');
    // The connection is one call of the session, holding control until the platform's limit at most.
    const [call] = Object.values((await forkRow(session.computer.id)).callsInFlight);
    expect(Date.parse(call!.until) - Date.now()).toBeGreaterThan(CDP_MAX_DURATION_MS - 30_000);
    expect(await session.state()).toBe('open');
    await page.close();
    // Closing the session ends the connection at the next re-check, and its call.
    await session.close();
    await disconnected;
    await vi.waitFor(async () => expect((await forkRow(session.computer.id)).callsInFlight).toEqual({}));
  });
});
