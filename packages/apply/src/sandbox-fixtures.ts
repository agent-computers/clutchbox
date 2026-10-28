import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Capture, CapturedCookie } from '@clutchbox/capture';
import { chromium } from 'playwright-core';
import { SANDBOX_CDP_PORT } from './sandbox';

// A sandbox stood in for by this machine, for tests only: commands run in a shell here, with a home of their own and
// Playwright's Chromium as the sandbox's Chrome (bunx playwright-core install chromium), headless and, as CI runners
// need, without its sandbox. Synthetic cookies only; no real browser data.
export async function localSandbox(port = SANDBOX_CDP_PORT + 1000 + Math.floor(Math.random() * 1000)) {
  const home = await mkdtemp(path.join(tmpdir(), 'sandbox-'));
  const env = {
    ...process.env,
    HOME: home,
    CLUTCHBOX_CHROME: chromium.executablePath(),
    CLUTCHBOX_CHROME_FLAGS: '--no-sandbox --headless=new',
  };
  const commands: string[] = [];
  const exec = (command: string, { stdin, timeoutMs }: { stdin?: string; timeoutMs: number }) =>
    new Promise<{ exitCode: number | null; stdout: string }>((resolve, reject) => {
      commands.push(command);
      const child = spawn('sh', ['-c', command], { env, timeout: timeoutMs });
      let stdout = '';
      child.stdout.on('data', chunk => {
        stdout += chunk;
      });
      child.on('error', reject);
      child.on('close', exitCode => resolve({ exitCode, stdout }));
      child.stdin.end(stdin ?? '');
    });
  // The Chrome's cookies, as Chrome holds them.
  const cookies = async () => {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    try {
      return await browser.contexts()[0]!.cookies();
    } finally {
      await browser.close();
    }
  };
  const stop = async () => {
    const version = await fetch(`http://127.0.0.1:${port}/json/version`)
      .then(response => response.json() as Promise<{ webSocketDebuggerUrl: string }>)
      .catch(() => null);
    if (!version) return;
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise(resolve => {
      socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      socket.onclose = resolve;
      socket.onerror = resolve;
    });
  };
  return { port, home, exec, commands, cookies, stop };
}

export const cookie = (overrides: Partial<CapturedCookie> = {}): CapturedCookie => ({
  name: 'sid',
  value: 'signed-in',
  domain: 'example.com',
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
export const capture = (cookies: CapturedCookie[], completedAt = new Date()): Capture => ({
  schemaVersion: 2,
  id: randomUUID(),
  scope: { mode: 'whole-browser', excludedDomains: [] },
  startedAt: new Date(completedAt.getTime() - 1000).toISOString(),
  completedAt: completedAt.toISOString(),
  consistency: 'non-atomic-cookie-read',
  coverage: 'cookies-only',
  storeId: '0',
  cookies,
});

// A command that prints, as JSON, the names of the cookies the sandbox's Chrome holds for `domain`, never their values:
// how a test run against a live provider checks the sign-in landed.
export const cookieNamesCommand = (domain: string, port = SANDBOX_CDP_PORT) =>
  `node -e "$(echo ${Buffer.from(
    `(async () => { const v = await (await fetch('http://127.0.0.1:${port}/json/version')).json(); const s = new WebSocket(v.webSocketDebuggerUrl); s.onopen = () => s.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' })); s.onmessage = e => { const m = JSON.parse(e.data); if (m.id !== 1) return; console.log(JSON.stringify(m.result.cookies.filter(c => c.domain.replace(/^[.]/, '') === '${domain}').map(c => c.name).sort())); process.exit(0); }; })();`,
  ).toString('base64')} | base64 -d)"`;
