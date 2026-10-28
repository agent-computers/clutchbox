import { type Applied, applyInSandbox, type SandboxApplyResult, type SandboxShell } from '@clutchbox/apply/sandbox';
import type { Capture } from '@clutchbox/capture';
import type { Client } from '@clutchbox/sdk';
import type { Sandbox } from 'e2b';

export { type Applied, SandboxApplyError } from '@clutchbox/apply/sandbox';

// A runtime adapter for E2B: applies a Clutchbox member's synced sign-ins to Chrome in your own E2B sandbox, through
// E2B's command API with the capture on standard input, so it never appears in a command line or on disk. Chrome
// listens for CDP on the sandbox's loopback only (@clutchbox/apply/sandbox).

// Clutchbox's public E2B template: a desktop with Google Chrome already running on the CDP port, the same one Clutchbox's
// own computers run. Any E2B team can start sandboxes from it, at its own cost. Another template works too if it has
// Node 22 or later and Chrome or Chromium, which the adapter starts on the desktop.
export const TEMPLATE = 'agent-computers-desktop';

// The part of an E2B sandbox the adapter uses: e2b's Sandbox, or @e2b/desktop's.
export type E2bSandbox = Pick<Sandbox, 'commands'>;

// Bytes of standard input per command: E2B streams it, so this only bounds each request.
const STDIN_BYTES = 1 << 20;

// E2B's command API as the apply runtime's shell: a background command with standard input open, fed and closed, then
// waited on. A non-zero exit resolves with its code (CommandExitError carries it).
export function e2bShell(sandbox: E2bSandbox): SandboxShell {
  return {
    maxStdinBytes: STDIN_BYTES,
    async run(command, { stdin, timeoutMs }) {
      const handle = await sandbox.commands.run(command, { background: true, stdin: true, timeoutMs });
      if (stdin) await sandbox.commands.sendStdin(handle.pid, stdin);
      await sandbox.commands.closeStdin(handle.pid);
      try {
        const result = await handle.wait();
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

// Applies a capture to the sandbox's Chrome. Pass the previous result's `applied` to write only what changed.
// `port` is the sandbox's Chrome's CDP port, 9222 unless you run it on another.
export const applyCapture = (
  sandbox: E2bSandbox,
  capture: Capture,
  previous?: Applied | null,
  { port }: { port?: number } = {},
) => applyInSandbox(e2bShell(sandbox), capture, previous, port === undefined ? {} : { port });

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
}: {
  client: Pick<Client, 'captures'>;
  member: string;
  profile?: string;
  sandbox: E2bSandbox;
  previous?: Applied | null;
  port?: number;
}): Promise<SandboxApplyResult & { profile: string; completedAt: string }> {
  const latest = await client.captures.latest(member, profile === undefined ? {} : { profile });
  const result = await applyCapture(sandbox, latest.capture, previous, port === undefined ? {} : { port });
  return { ...result, profile: latest.profile, completedAt: latest.completedAt };
}
