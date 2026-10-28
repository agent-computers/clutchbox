import type { BoatApi, CommandResponse } from '@boatdev/sdk';
import { type Applied, applyInSandbox, type SandboxApplyResult, type SandboxShell } from '@clutchbox/apply/sandbox';
import type { Capture } from '@clutchbox/capture';
import type { Client } from '@clutchbox/sdk';

export { type Applied, SandboxApplyError } from '@clutchbox/apply/sandbox';

// A runtime adapter for Boat: applies a Clutchbox member's synced sign-ins to Chrome in your own Boat sandbox, through
// Boat's command and file APIs. Boat's commands take no standard input and Boat keeps their command lines, so the
// capture goes in a file in PRIVATE_DIR, which the adapter mounts in memory first (with the sandbox's passwordless
// sudo) and the helper deletes once read: never on disk. The adapter starts a Chrome of its own with CDP on the
// sandbox's loopback (@clutchbox/apply/sandbox), on its desktop; the agent drives that Chrome, at CDP port 9222 inside
// the sandbox. Resuming a stopped Boat sandbox reboots it, so apply again after every resume: the restarted Chrome gets
// the whole capture again, session cookies included.

// Boat writes files only under /home/user and /tmp.
export const PRIVATE_DIR = '/tmp/clutchbox';

// A Boat sandbox: your client, and the sandbox's ID.
export type BoatSandbox = { boat: Pick<BoatApi, 'command' | 'writeFile'>; sandboxId: string };

// Boat's command API as the apply runtime's shell: synchronous commands of at most 600 seconds.
export function boatShell({ boat, sandboxId }: BoatSandbox, privateDir = PRIVATE_DIR): SandboxShell {
  return {
    maxStdinBytes: 0,
    privateDir,
    async run(command, { timeoutMs }) {
      const timeoutSeconds = Math.min(600, Math.max(1, Math.floor(timeoutMs / 1000)));
      const result = (await boat.command({ sandboxId, command, timeoutSeconds })) as CommandResponse;
      return { exitCode: result.exitCode, stdout: result.stdout };
    },
    async writeFile(path, content) {
      await boat.writeFile({ sandboxId, path, content, encoding: 'utf8' });
    },
  };
}

// Applies a capture to the sandbox's Chrome. Pass the previous result's `applied` to write only what changed.
// `port` is the sandbox's Chrome's CDP port, 9222 unless you run it on another; `privateDir`, a directory for the
// payload under /home/user or /tmp, PRIVATE_DIR unless you have one in memory already.
export const applyCapture = (
  sandbox: BoatSandbox,
  capture: Capture,
  previous?: Applied | null,
  { port, privateDir }: { port?: number; privateDir?: string } = {},
) => applyInSandbox(boatShell(sandbox, privateDir), capture, previous, port === undefined ? {} : { port });

// Reads the member's latest capture with your Clutchbox client (@clutchbox/sdk, an organization API key with the
// captures scope), the default profile's or `profile`'s, and applies it to the sandbox's Chrome. Keep `applied` from
// the result, private, for the next call on the same sandbox and profile.
export async function applyLatestCapture({
  client,
  member,
  profile,
  sandbox,
  previous,
  port,
  privateDir,
}: {
  client: Pick<Client, 'captures'>;
  member: string;
  profile?: string;
  sandbox: BoatSandbox;
  previous?: Applied | null;
  port?: number;
  privateDir?: string;
}): Promise<SandboxApplyResult & { profile: string; completedAt: string }> {
  const latest = await client.captures.latest(member, profile === undefined ? {} : { profile });
  const result = await applyCapture(sandbox, latest.capture, previous, {
    ...(port === undefined ? {} : { port }),
    ...(privateDir === undefined ? {} : { privateDir }),
  });
  return { ...result, profile: latest.profile, completedAt: latest.completedAt };
}
