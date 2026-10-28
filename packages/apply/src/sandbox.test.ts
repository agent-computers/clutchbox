import { siteOfHost } from '@clutchbox/capture';
import { afterEach, describe, expect, it } from 'vitest';
import { type CdpCookie, cookieParamOf, partitionCookies } from './chrome';
import { applyInSandbox, payloads, SANDBOX_CORE, type SandboxShell } from './sandbox';
import { capture, cookie, localSandbox } from './sandbox-fixtures';

const held: CdpCookie = {
  name: 'a',
  value: 'b',
  domain: '.mail.example.co.uk',
  path: '/',
  expires: 2_000_000_000,
  secure: true,
  httpOnly: false,
  session: false,
  sameSite: 'Lax',
  partitionKey: 'https://example.co.uk',
};

describe('the sandbox helper', () => {
  it("runs the apply runtime's cookie logic", () => {
    const core = new Function(`${SANDBOX_CORE}; return { siteOfHost, toParam, partition };`)();
    for (const host of ['mail.google.com', '.example.co.uk', 'a.b.github.io', 'localhost'])
      expect(core.siteOfHost(host)).toBe(siteOfHost(host));
    expect(core.toParam(held)).toEqual(cookieParamOf(held));
    expect(core.partition([held], ['example.co.uk'])).toEqual(partitionCookies([held], ['example.co.uk']));
  });
  it('splits a payload to fit standard input, clearing sites only in the first', () => {
    const cookies = Array.from({ length: 30 }, (_, i) => ({ name: `c${i}`, value: 'x'.repeat(100) }));
    const bodies = payloads(['example.com'], cookies, 1_000);
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.every(body => Buffer.byteLength(body) <= 1_000)).toBe(true);
    const parsed = bodies.map(body => JSON.parse(body));
    expect(parsed.map(body => body.clearSites)).toEqual([['example.com'], ...parsed.slice(1).map(() => [])]);
    expect(parsed.flatMap(body => body.cookies)).toEqual(cookies);
    expect(payloads(['example.com'], cookies, 0)).toHaveLength(1);
  });
});

describe('applying in a sandbox', () => {
  let sandbox: Awaited<ReturnType<typeof localSandbox>> | undefined;
  afterEach(() => sandbox?.stop());
  const shellOf = (box: NonNullable<typeof sandbox>, maxStdinBytes = 1 << 20): SandboxShell => ({
    run: box.exec,
    maxStdinBytes,
  });

  it('starts Chrome, signs it in, then writes only what changed, never in a command line', async () => {
    sandbox = await localSandbox();
    const shell = shellOf(sandbox, 600);
    const first = capture([cookie(), cookie({ name: 'pref', value: 'dark' }), cookie({ domain: 'notion.so' })]);
    const result = await applyInSandbox(shell, first, null, { port: sandbox.port });
    expect(result).toMatchObject({ set: 3, failed: 0, cleared: 0 });
    expect((await sandbox.cookies()).map(each => `${each.domain} ${each.name}=${each.value}`).sort()).toEqual([
      'example.com pref=dark',
      'example.com sid=signed-in',
      'notion.so sid=signed-in',
    ]);
    // A later capture: one cookie changed, one deleted; the rest stay as Chrome has them.
    const next = capture([cookie({ value: 'renewed' }), cookie({ domain: 'notion.so' })]);
    expect(await applyInSandbox(shell, next, result.applied, { port: sandbox.port })).toMatchObject({ set: 2 });
    expect((await sandbox.cookies()).map(each => `${each.domain} ${each.name}=${each.value}`).sort()).toEqual([
      'example.com sid=renewed',
      'notion.so sid=signed-in',
    ]);
    expect(sandbox.commands.join('\n')).not.toMatch(/signed-in|renewed|dark/);
  });
  it('applies in full again once Chrome restarted, as after a sandbox rebooted', async () => {
    sandbox = await localSandbox();
    const shell = shellOf(sandbox);
    const first = capture([cookie({ session: true }), cookie({ domain: 'notion.so' })]);
    const { applied } = await applyInSandbox(shell, first, null, { port: sandbox.port });
    await sandbox.stop();
    // Nothing changed in the user's browser, but the restarted Chrome lost the session cookie.
    expect(await applyInSandbox(shell, first, applied, { port: sandbox.port })).toMatchObject({ set: 2 });
    expect((await sandbox.cookies()).map(each => each.domain).sort()).toEqual(['example.com', 'notion.so']);
    // While it runs, the same capture writes nothing.
    expect(await applyInSandbox(shell, first, applied, { port: sandbox.port })).toMatchObject({ set: 0 });
  });
  it('passes the payload in a memory-only file without standard input, and deletes it', async () => {
    sandbox = await localSandbox();
    const { mkdir, readdir, rm, writeFile } = await import('node:fs/promises');
    const privateDir = `/dev/shm/clutchbox-test-${process.pid}-${sandbox.port}`;
    await mkdir(privateDir, { recursive: true });
    const shell: SandboxShell = {
      run: sandbox.exec,
      maxStdinBytes: 0,
      privateDir,
      writeFile: (file, data) => writeFile(file, data, { mode: 0o600 }),
    };
    expect(await applyInSandbox(shell, capture([cookie()]), null, { port: sandbox.port })).toMatchObject({ set: 1 });
    expect(await readdir(privateDir)).toEqual([]);
    await rm(privateDir, { recursive: true });
    // A directory on disk gets memory mounted on it with passwordless sudo, and is refused without.
    const onDisk = `${sandbox.home}/payloads`;
    const mounting = applyInSandbox({ ...shell, privateDir: onDisk }, capture([cookie()]), null, {
      port: sandbox.port,
    });
    if ((await sandbox.exec('sudo -n true', { timeoutMs: 5_000 })).exitCode === 0) {
      await expect(mounting).resolves.toMatchObject({ set: 1 });
      expect((await sandbox.exec(`stat -f -c %T ${onDisk}`, { timeoutMs: 5_000 })).stdout.trim()).toBe('tmpfs');
      await sandbox.exec(`sudo -n umount ${onDisk}`, { timeoutMs: 5_000 });
    } else await expect(mounting).rejects.toMatchObject({ code: 'no_private_memory' });
  });
  it('names a failure by its code, without the output', async () => {
    const shell: SandboxShell = {
      run: async () => ({ exitCode: 1, stdout: '{"error":"no_chrome"}' }),
      maxStdinBytes: 1 << 20,
    };
    await expect(applyInSandbox(shell, capture([cookie()]))).rejects.toMatchObject({ code: 'no_chrome' });
    const leaky: SandboxShell = { run: async () => ({ exitCode: 1, stdout: 'sid=signed-in' }), maxStdinBytes: 1 };
    await expect(applyInSandbox(leaky, capture([cookie()]))).rejects.toMatchObject({ code: 'command_failed' });
  });
});
