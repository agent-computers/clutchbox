import { capture, cookie, cookieNamesCommand, localSandbox } from '@clutchbox/apply/sandbox-fixtures';
import { Sandbox } from 'e2b';
import { afterEach, describe, expect, it } from 'vitest';
import { applyLatestCapture, type E2bSandbox, e2bShell, TEMPLATE } from './index';

// E2B's command API stood in for by this machine: standard input is buffered until it is closed, and a non-zero exit
// rejects with the result, as e2b's CommandExitError does.
function fakeE2b(local: Awaited<ReturnType<typeof localSandbox>>) {
  const stdin = new Map<number, string>();
  let pid = 0;
  const sandbox = {
    commands: {
      run: async (command: string, { timeoutMs }: { timeoutMs: number }) => {
        const id = ++pid;
        stdin.set(id, '');
        return {
          pid: id,
          wait: async () => {
            const result = await local.exec(command, { stdin: stdin.get(id)!, timeoutMs });
            if (result.exitCode !== 0) throw Object.assign(new Error('exit'), result);
            return { ...result, stderr: '' };
          },
        };
      },
      sendStdin: async (id: number, data: string) => {
        stdin.set(id, stdin.get(id)! + data);
      },
      closeStdin: async () => {},
    },
  };
  return sandbox as unknown as E2bSandbox;
}
const client = (cookies = [cookie()]) => ({
  captures: {
    latest: async (member: string) => ({ member, profile: 'brw_test', completedAt: 'now', capture: capture(cookies) }),
  },
});

describe('the E2B runtime adapter', () => {
  let local: Awaited<ReturnType<typeof localSandbox>> | undefined;
  afterEach(() => local?.stop());
  it("signs the sandbox's Chrome in to the member's sites through E2B's commands", async () => {
    local = await localSandbox();
    const result = await applyLatestCapture({
      client: client(),
      member: 'mbr_1',
      sandbox: fakeE2b(local),
      port: local.port,
    });
    expect(result).toMatchObject({ set: 1, failed: 0, profile: 'brw_test' });
    expect((await local.cookies()).map(each => `${each.domain} ${each.name}`)).toEqual(['example.com sid']);
    expect(local.commands.join('\n')).not.toContain('signed-in');
  });
  it('resolves with the exit code and output of a command that failed', async () => {
    const failed = Object.assign(new Error('exit'), { exitCode: 1, stdout: '{"error":"no_chrome"}' });
    const shell = e2bShell({
      commands: {
        run: async () => ({ pid: 1, wait: () => Promise.reject(failed) }),
        sendStdin: async () => {},
        closeStdin: async () => {},
      },
    } as unknown as E2bSandbox);
    expect(await shell.run('true', { stdin: '{}', timeoutMs: 5_000 })).toEqual({
      exitCode: 1,
      stdout: '{"error":"no_chrome"}',
    });
  });
});

// Against E2B itself, from Clutchbox's public template: skipped without E2B_API_KEY.
describe.skipIf(!process.env.E2B_API_KEY)('the E2B runtime adapter on E2B', () => {
  it('signs a fresh sandbox in to a test site', { timeout: 240_000 }, async () => {
    const sandbox = await Sandbox.create(TEMPLATE, { timeoutMs: 300_000 });
    try {
      const result = await applyLatestCapture({ client: client(), member: 'mbr_1', sandbox });
      expect(result).toMatchObject({ set: 1, failed: 0 });
      const { stdout } = await sandbox.commands.run(cookieNamesCommand('example.com'));
      expect(JSON.parse(stdout)).toEqual(['sid']);
    } finally {
      await sandbox.kill();
    }
  });
});
