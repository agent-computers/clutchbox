import { type Applied, applyInSandbox, type SandboxApplyResult, type SandboxShell } from '@clutchbox/apply/sandbox';
import type { Capture } from '@clutchbox/capture';
import type { Client } from '@clutchbox/sdk';
import type { Sandbox } from '@insforge/instabox-sdk';

export { type Applied, SandboxApplyError } from '@clutchbox/apply/sandbox';

// A runtime adapter for Instabox: applies a Clutchbox member's synced sign-ins to Chromium in your own Instabox sandbox,
// through Instabox's command API with the capture on standard input, so it never appears in a command line or on
// disk. Instabox documents no CDP access from outside, and a public port would be open to anyone, so the adapter
// starts a Chromium of its own with CDP on the sandbox's loopback (@clutchbox/apply/sandbox), on the desktop of the
// agent-browser template. The agent drives that Chromium, at CDP port 9222 inside the sandbox.

// The part of an Instabox sandbox the adapter uses.
export type InstaboxSandbox = Pick<Sandbox, 'commands'>;

// Instabox takes at most 1 MiB of standard input per command (MAX_STDIN_BYTES); larger captures go in several.
const STDIN_BYTES = 1 << 20;

// Instabox's command API as the apply runtime's shell. run throws CommandExitError, carrying the result, on a non-zero
// exit.
export function instaboxShell(sandbox: InstaboxSandbox): SandboxShell {
  return {
    maxStdinBytes: STDIN_BYTES,
    async run(command, { stdin, timeoutMs }) {
      try {
        const result = await sandbox.commands.run(command, { timeoutMs, ...(stdin === undefined ? {} : { stdin }) });
        return { exitCode: result.exitCode, stdout: result.stdout };
      } catch (error) {
        const exited = error as { exitCode?: unknown; stdout?: unknown };
        if (typeof exited.exitCode === 'number')
          return { exitCode: exited.exitCode, stdout: typeof exited.stdout === 'string' ? exited.stdout : '' };
        throw error;
      }
    },
  };
}

// Applies a capture to the sandbox's Chromium. Pass the previous result's `applied` to write only what changed.
// `port` is the sandbox's Chrome's CDP port, 9222 unless you run it on another.
export const applyCapture = (
  sandbox: InstaboxSandbox,
  capture: Capture,
  previous?: Applied | null,
  { port }: { port?: number } = {},
) => applyInSandbox(instaboxShell(sandbox), capture, previous, port === undefined ? {} : { port });

// Reads the member's latest capture with your Clutchbox client (@clutchbox/sdk, an organization API key with the
// captures scope), the default profile's or `profile`'s, and applies it to the sandbox's Chromium. Keep `applied` from
// the result, private, for the next call on the same sandbox and profile.
export async function applyLatestCapture({
  client,
  member,
  profile,
  sandbox,
  previous,
  port,
}: {
  client: Pick<Client, 'captures'>;
  member: string;
  profile?: string;
  sandbox: InstaboxSandbox;
  previous?: Applied | null;
  port?: number;
}): Promise<SandboxApplyResult & { profile: string; completedAt: string }> {
  const latest = await client.captures.latest(member, profile === undefined ? {} : { profile });
  const result = await applyCapture(sandbox, latest.capture, previous, port === undefined ? {} : { port });
  return { ...result, profile: latest.profile, completedAt: latest.completedAt };
}
