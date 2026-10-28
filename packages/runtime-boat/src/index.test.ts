import { rm, writeFile } from 'node:fs/promises';
import { BoatApi, type CommandResponse, Configuration, waitUntilReady } from '@boatdev/sdk';
import { applyInSandbox } from '@clutchbox/apply/sandbox';
import { capture, cookie, cookieNamesCommand, localSandbox } from '@clutchbox/apply/sandbox-fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { applyLatestCapture, type BoatSandbox, boatShell, PRIVATE_DIR } from './index';

// Boat's command and file APIs stood in for by this machine: no standard input, and whole commands kept, as Boat's
// command history keeps them.
function fakeBoat(local: Awaited<ReturnType<typeof localSandbox>>) {
  const written: string[] = [];
  const boat = {
    command: async ({ command, timeoutSeconds }: { command: string; timeoutSeconds: number }) => ({
      ...(await local.exec(command, { timeoutMs: timeoutSeconds * 1000 })),
      stderr: '',
    }),
    writeFile: async ({ path, content }: { path: string; content: string }) => {
      written.push(path);
      await writeFile(path, content, { mode: 0o600 });
    },
  };
  return { sandbox: { boat, sandboxId: 'sbx_test' } as unknown as BoatSandbox, written };
}
const client = (cookies = [cookie()]) => ({
  captures: {
    latest: async (member: string) => ({ member, profile: 'brw_test', completedAt: 'now', capture: capture(cookies) }),
  },
});

describe('the Boat runtime adapter', () => {
  let local: Awaited<ReturnType<typeof localSandbox>> | undefined;
  // In memory already (as a tmpfs /tmp is), so the tests mount nothing.
  const dir = `/dev/shm/clutchbox-boat-${process.pid}`;
  afterEach(async () => {
    await local?.stop();
    await rm(dir, { recursive: true, force: true });
    await rm(`${dir}-latest`, { recursive: true, force: true });
  });
  it("signs the sandbox's Chrome in through a memory-only file, kept out of Boat's command history", async () => {
    local = await localSandbox();
    const { sandbox, written } = fakeBoat(local);
    const result = await applyInSandbox(boatShell(sandbox, dir), capture([cookie()]), null, { port: local.port });
    expect(result).toMatchObject({ set: 1, failed: 0 });
    expect(written).toHaveLength(1);
    expect(written[0]!.startsWith(`${dir}/`)).toBe(true);
    expect((await local.exec(`ls -A ${dir}`, { timeoutMs: 5_000 })).stdout).toBe('');
    expect(local.commands.join('\n')).not.toContain('signed-in');
    expect(PRIVATE_DIR.startsWith('/tmp/')).toBe(true);
  });
  it('applies the latest capture in one call', async () => {
    local = await localSandbox();
    const { sandbox } = fakeBoat(local);
    const result = await applyLatestCapture({
      client: client(),
      member: 'mbr_1',
      sandbox,
      port: local.port,
      privateDir: `${dir}-latest`,
    });
    expect(result).toMatchObject({ set: 1, profile: 'brw_test' });
  });
});

// Against Boat itself: skipped without BOAT_API_KEY.
describe.skipIf(!process.env.BOAT_API_KEY)('the Boat runtime adapter on Boat', () => {
  it('signs a fresh sandbox in to a test site', { timeout: 600_000 }, async () => {
    const boat = new BoatApi(
      new Configuration({ basePath: 'https://boat.dev/api/v1', accessToken: process.env.BOAT_API_KEY! }),
    );
    const sandboxId = (await boat.create({ ttlSeconds: 900, noEnv: true })).sandbox.id;
    try {
      await waitUntilReady(boat, sandboxId);
      const result = await applyLatestCapture({ client: client(), member: 'mbr_1', sandbox: { boat, sandboxId } });
      expect(result).toMatchObject({ set: 1, failed: 0 });
      const names = (await boat.command({ sandboxId, command: cookieNamesCommand('example.com') })) as CommandResponse;
      expect(JSON.parse(names.stdout)).toEqual(['sid']);
    } finally {
      await boat.deleteSandbox({ sandboxId, xAsciiConfirmDelete: sandboxId });
    }
  });
});
