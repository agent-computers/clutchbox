import type { CdpCookieParam } from '@agent-computers/apply';
import { z } from 'zod';

// What a computer offers, whatever runs it: a provider creates, resumes, and pauses computers, and a session
// controls one. Adapters implement these for a sandbox provider (packages/e2b).
// The desktop's size; screenshots and actions use its coordinates.
export const DISPLAY = { width: 1280, height: 800 };
// A key name (Return, ctrl, F5, a) or a chord of them joined by +, in characters a shell passes through unquoted:
// adapters may hand keys to a command line, as E2B's xdotool does. Text, symbols included, goes through `type`.
export const keyNamePattern = /^[A-Za-z0-9_+.,=/:-]+$/;
const keyName = z
  .string()
  .min(1)
  .max(40)
  .regex(keyNamePattern, 'A key name, such as Return, ctrl, or a; type text with type.');
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
      keys: z.union([keyName, z.array(keyName).min(1).max(5)]),
    })
    .strict(),
  z.object({ type: z.literal('wait'), ms: z.int().min(1).max(5000) }).strict(),
]);
export type ComputerAction = z.infer<typeof actionSchema>;
// A Chrome profile on a computer: its own user data directory, so its cookies and storage stay apart from every other
// profile's. Names are the caller's, in characters a shell passes through unquoted. FIRST_PROFILE is the directory a
// computer's Chrome ran before profiles, which the first profile a computer gets keeps.
// Computer sizes. People see each by its spec (2 vCPU · 4 GB, sizeName); the keys are stored identifiers only. Two CPUs
// and 4 GB run Chrome on real pages; the larger sizes are for heavier sites and more tabs. E2B refuses templates with
// more than 8 GB of memory unless its support raises the limit, so the largest size has 8 CPUs and 8 GB. A computer
// keeps the size it was created at, and a fork its main computer's, since a fork starts from the main computer's memory.
export const COMPUTER_SIZES = {
  '1x': { cpuCount: 2, memoryMB: 4096 },
  '2x': { cpuCount: 4, memoryMB: 8192 },
  '4x': { cpuCount: 8, memoryMB: 8192 },
} as const;
export type ComputerSize = keyof typeof COMPUTER_SIZES;
export const COMPUTER_SIZE_NAMES = Object.keys(COMPUTER_SIZES) as [ComputerSize, ...ComputerSize[]];
// A size as people see it, by its spec.
export const sizeName = (size: ComputerSize) =>
  `${COMPUTER_SIZES[size].cpuCount} vCPU · ${COMPUTER_SIZES[size].memoryMB / 1024} GB`;
export const PROFILE_PATTERN = /^[a-z0-9_]{1,64}$/;
export const FIRST_PROFILE = 'default';
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
  // The provider pauses the computer timeoutMs from now unless called again; may shorten the timeout.
  setTimeout(timeoutMs: number): Promise<void>;
  // Brings a computer made from an older template to the provider's revision, restarting the browser (its
  // profile and sign-ins stay, its tabs close). Nothing may run on the computer later than budgetMs after.
  refresh(budgetMs: number): Promise<'current' | 'refreshed'>;
  // Sets the system time zone (a valid IANA name), which a running Chrome follows at once.
  setTimeZone(timeZone: string): Promise<void>;
  // Runs Chrome on `profile` (PROFILE_PATTERN), the one Chrome every other method uses until the next call: a Chrome on
  // another profile is stopped gracefully first, so its cookies reach disk, and its tabs close. A computer runs
  // FIRST_PROFILE until told otherwise. Done, or failed, within budgetMs; a failure leaves no Chrome on the wrong profile.
  useProfile(profile: string, budgetMs: number): Promise<void>;
  // Replaces every cookie of clearSites, then sets `cookies` (an expired one deletes its match); other
  // sites' cookies are kept. Refused unless Chrome runs `profile`, so one profile's cookies never reach another. Nothing
  // may change cookies later than budgetMs after the call, even when it fails.
  syncCookies(input: {
    profile: string;
    clearSites: string[];
    cookies: CdpCookieParam[];
    budgetMs: number;
  }): Promise<{ kept: number; cleared: number; set: number }>;
  // Starts live view's stream unless it runs (x11vnc on the display, behind websockify) and says where to reach it:
  // a WebSocket URL and the headers it needs, which carry the provider's traffic token, so they never leave the
  // server. Refuses a computer that accepts public traffic. Done within budgetMs.
  stream(budgetMs: number): Promise<{ url: string; headers: Record<string, string> }>;
  // Starts Chrome and a bridge to its DevTools unless they run, and says where to reach the browser's CDP WebSocket, as
  // stream() does for live view: the headers carry the provider's traffic token, so they never leave the server.
  // Refuses a computer that accepts public traffic. Done within budgetMs.
  cdpEndpoint(budgetMs: number): Promise<{ url: string; headers: Record<string, string> }>;
  // Makes `text` the computer's clipboard, owned anew, so the next paste there gets it (live view's paste). Done, or
  // failed, within budgetMs.
  setClipboard(text: string, budgetMs: number): Promise<void>;
  // Whether the computer refuses traffic without the provider's token. One created before that accepts
  // public traffic until it is reset, and live view refuses it.
  readonly isPrivate: boolean;
}
// Thrown by a provider on an account its owner brought (such as an organization's own E2B API key) when the provider
// refuses that account: the key was revoked, or the account can't pay. Only someone who manages the account can fix it.
export class ProviderAccountRefused extends Error {
  readonly code = 'provider_account_refused';
  constructor(cause?: unknown) {
    super('The provider refused the account', { cause });
    this.name = 'ProviderAccountRefused';
  }
}
export interface ComputerProvider {
  // Who runs the computers, as agents are told, such as "e2b".
  name: string;
  // The helpers and browser setup a computer should run; changes when the provider's do (refresh).
  revision: string;
  // Reconciles a create whose response was lost: provider metadata carries the computer's public ID.
  find(computerId: string): Promise<string | null>;
  // timeoutMs: the provider pauses the computer this long after the call unless called again.
  create(computerId: string, timeoutMs: number, size: ComputerSize): Promise<string>;
  // A fork: a new computer from a snapshot, with its memory, so the browser runs as it did when the snapshot was
  // taken, at the size of the computer it was taken from. Paused after timeoutMs like create, and found by its own
  // computerId.
  createFromSnapshot(snapshotId: string, computerId: string, timeoutMs: number): Promise<string>;
  // Snapshots a computer's memory and disk and returns the snapshot's ID. A paused computer is resumed first and then
  // runs until timeoutMs from now; a running one pauses briefly, and every connection to it drops.
  snapshot(sandboxId: string, timeoutMs: number): Promise<string>;
  // Deletes a snapshot. Fails while any computer made from it remains, running or paused.
  deleteSnapshot(snapshotId: string): Promise<void>;
  // Resumes a paused computer; on a running one it only ever extends the timeout.
  connect(sandboxId: string, timeoutMs: number): Promise<ComputerSession>;
  pause(sandboxId: string): Promise<void>;
  // The provider pauses a running computer timeoutMs from now, shorter or longer than before, without waking a
  // paused one the way connect would. Bounded: callers hold the computer row lock across it.
  setTimeout(sandboxId: string, timeoutMs: number): Promise<void>;
  kill(sandboxId: string): Promise<void>;
}
