import type { CdpCookieParam } from '@agent-computers/apply';
import { z } from 'zod';

// What an agent computer offers, whatever runs it: a provider creates, resumes, and pauses computers, and a session
// controls one. Adapters implement these for a sandbox provider (packages/e2b).
// The desktop's size; screenshots and actions use its coordinates.
export const DISPLAY = { width: 1280, height: 800 };
export const actionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('click'),
      x: z.int().min(0),
      y: z.int().min(0),
      button: z.enum(['left', 'right', 'middle']).default('left'),
      double: z.boolean().default(false),
    })
    .strict(),
  z.object({ type: z.literal('move'), x: z.int().min(0), y: z.int().min(0) }).strict(),
  z
    .object({
      type: z.literal('drag'),
      from: z.tuple([z.int().min(0), z.int().min(0)]),
      to: z.tuple([z.int().min(0), z.int().min(0)]),
    })
    .strict(),
  z
    .object({
      type: z.literal('scroll'),
      x: z.int().min(0).optional(),
      y: z.int().min(0).optional(),
      direction: z.enum(['up', 'down']),
      amount: z.int().min(1).max(20).default(3),
    })
    .strict(),
  z.object({ type: z.literal('type'), text: z.string().min(1).max(2000) }).strict(),
  z
    .object({
      type: z.literal('key'),
      keys: z.union([z.string().min(1).max(40), z.array(z.string().min(1).max(40)).min(1).max(5)]),
    })
    .strict(),
  z.object({ type: z.literal('wait'), ms: z.int().min(1).max(5000) }).strict(),
]);
export type ComputerAction = z.infer<typeof actionSchema>;
export type ExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
};

export interface ComputerSession {
  screenshot(): Promise<Uint8Array>;
  act(action: ComputerAction): Promise<void>;
  cdp(input: {
    method: string;
    params?: Record<string, unknown> | undefined;
    targetId?: string | undefined;
  }): Promise<string>;
  exec(input: { command: string; cwd?: string | undefined; timeoutSeconds: number }): Promise<ExecResult>;
  // Closes every browser tab but one blank one. Never starts the browser.
  closeTabs(): Promise<void>;
  downloadUrl(path: string): Promise<string>;
  // The provider pauses the computer timeoutMs from now unless called again; may shorten the timeout.
  setTimeout(timeoutMs: number): Promise<void>;
  // Brings a computer made from an older template to the provider's revision, restarting the browser (its
  // profile and sign-ins stay, its tabs close). Nothing may run on the computer later than budgetMs after.
  refresh(budgetMs: number): Promise<'current' | 'refreshed'>;
  // Sets the system time zone (a valid IANA name), which a running Chrome follows at once.
  setTimeZone(timeZone: string): Promise<void>;
  // Replaces every cookie of clearSites, then sets `cookies` (an expired one deletes its match); other
  // sites' cookies are kept. Nothing may change cookies later than budgetMs after the call, even when it fails.
  syncCookies(input: {
    clearSites: string[];
    cookies: CdpCookieParam[];
    budgetMs: number;
  }): Promise<{ kept: number; cleared: number; set: number }>;
  // Starts live view's stream unless it runs (x11vnc on the display, behind websockify) and says where to reach it:
  // a WebSocket URL and the headers it needs, which carry the provider's traffic token, so they never leave the
  // server. Refuses a computer that accepts public traffic. Done within budgetMs.
  stream(budgetMs: number): Promise<{ url: string; headers: Record<string, string> }>;
  // Makes `text` the computer's clipboard, owned anew, so the next paste there gets it (live view's paste). Done, or
  // failed, within budgetMs.
  setClipboard(text: string, budgetMs: number): Promise<void>;
  // Whether the computer refuses traffic without the provider's token. One created before that accepts
  // public traffic until it is reset, and live view refuses it.
  readonly isPrivate: boolean;
}
export interface ComputerProvider {
  // The helpers and browser setup a computer should run; changes when the provider's do (refresh).
  revision: string;
  // Reconciles a create whose response was lost: provider metadata carries the computer's public ID.
  find(computerId: string): Promise<string | null>;
  // timeoutMs: the provider pauses the computer this long after the call unless called again.
  create(computerId: string, timeoutMs: number): Promise<string>;
  // Resumes a paused computer; on a running one it only ever extends the timeout.
  connect(sandboxId: string, timeoutMs: number): Promise<ComputerSession>;
  pause(sandboxId: string): Promise<void>;
  // The provider pauses a running computer timeoutMs from now, shorter or longer than before, without waking a
  // paused one the way connect would. Bounded: callers hold the computer row lock across it.
  setTimeout(sandboxId: string, timeoutMs: number): Promise<void>;
  kill(sandboxId: string): Promise<void>;
}
