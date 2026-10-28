import { capture, cookie, cookieNamesCommand, localSandbox } from '@clutchbox/apply/sandbox-fixtures';
import { MAX_STDIN_BYTES, Sandbox } from '@insforge/instabox-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { applyLatestCapture, type InstaboxSandbox } from './index';

// Instabox's command API stood in for by this machine: standard input of at most MAX_STDIN_BYTES, and a non-zero exit
// rejects with the result, as its CommandExitError does.
function fakeInstabox(local: Awaited<ReturnType<typeof localSandbox>>) {
  const stdins: number[] = [];
  const sandbox = {
    commands: {
      run: async (command: string, { stdin, timeoutMs }: { stdin?: string; timeoutMs: number }) => {
        stdins.push(Buffer.byteLength(stdin ?? ''));
        if (Buffer.byteLength(stdin ?? '') > MAX_STDIN_BYTES) throw new Error('stdin too large');
        const result = await local.exec(command, { ...(stdin === undefined ? {} : { stdin }), timeoutMs });
        if (result.exitCode !== 0) throw Object.assign(new Error('exit'), { ...result, stderr: '' });
        return { ...result, stderr: '', timedOut: false, truncated: false };
      },
    },
  };
  return { sandbox: sandbox as unknown as InstaboxSandbox, stdins };
}
const client = (cookies = [cookie()]) => ({
  captures: {
    latest: async (member: string) => ({ member, profile: 'brw_test', completedAt: 'now', capture: capture(cookies) }),
  },
});

describe('the Instabox runtime adapter', () => {
  let local: Awaited<ReturnType<typeof localSandbox>> | undefined;
  afterEach(() => local?.stop());
  it("signs the sandbox's Chromium in through Instabox's commands, in pieces that fit their standard input", async () => {
    local = await localSandbox();
    const { sandbox, stdins } = fakeInstabox(local);
    // About 1.5 MiB of cookies on ten sites, within Chrome's 180 per site: more than one command's standard input.
    const cookies = Array.from({ length: 700 }, (_, i) =>
      cookie({ name: `c${i}`, domain: `site${i % 10}.test`, value: 'v'.repeat(2_000) }),
    );
    const result = await applyLatestCapture({ client: client(cookies), member: 'mbr_1', sandbox, port: local.port });
    expect(result).toMatchObject({ set: 700, failed: 0, profile: 'brw_test' });
    expect(stdins.filter(bytes => bytes > 0).length).toBeGreaterThan(1);
    expect((await local.cookies()).length).toBe(700);
    expect(local.commands.join('\n')).not.toContain('vvvv');
  });
});

// Against Instabox itself, on its default agent-browser template: skipped without INSTABOX_API_KEY.
describe.skipIf(!process.env.INSTABOX_API_KEY)('the Instabox runtime adapter on Instabox', () => {
  it('signs a fresh sandbox in to a test site', { timeout: 300_000 }, async () => {
    const sandbox = await Sandbox.create();
    try {
      const result = await applyLatestCapture({ client: client(), member: 'mbr_1', sandbox });
      expect(result).toMatchObject({ set: 1, failed: 0 });
      const { stdout } = await sandbox.commands.run(cookieNamesCommand('example.com'));
      expect(JSON.parse(stdout)).toEqual(['sid']);
    } finally {
      await Sandbox.kill(sandbox.sandboxId);
    }
  });
});
