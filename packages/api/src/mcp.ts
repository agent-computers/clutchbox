import 'server-only';
import { requireMcpAuth } from '@better-auth/mcp';
import type { Auth } from '@clutchbox/server/auth';
import type { Profile } from '@clutchbox/server/captures';
import {
  ACT_ACTION_ESTIMATE_MS,
  ACT_MAX_WAIT_MS,
  CALL_BUDGET_MS,
  EXEC_MAX_SECONDS,
  FORK_UNUSED_MS,
  IDLE_PAUSE_MS,
  TYPE_KEY_DELAY_MS,
} from '@clutchbox/server/computer-timing';
import {
  accountRefusal,
  actionSchema,
  type Caller,
  type ComputerAction,
  type ComputerFailure,
  type ComputerProvider,
  type Computers,
  closeComputerSession,
  DISPLAY,
  listForks,
  openComputerSession,
  type SessionHandle,
  type SyncSummary,
  sizeName,
  useComputerSession,
} from '@clutchbox/server/computers';
import type { Database } from '@clutchbox/server/database';
import { defaultServerHooks, type Metering, type ServerHooks } from '@clutchbox/server/hooks';
import { errorLabel, logError } from '@clutchbox/server/log';
import { grantIsLive, liveMcpPrincipal, MCP_SCOPE, type McpPrincipal } from '@clutchbox/server/mcp';
import type { Member } from '@clutchbox/server/organizations';
import { noteAgentConnected, noteSetupStep } from '@clutchbox/server/setup';
import {
  markToolStep,
  recordToolCall,
  type ToolTrace,
  toolCallFailed,
  withToolTrace,
} from '@clutchbox/server/tool-calls';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { BrowserError, browserAction, browserInput, missingInput } from './browser';

// The remote MCP endpoint (/api/mcp): OAuth-protected transport and the computer tools,
// presented over the grant and computer modules in packages/server.
const result = (data: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  structuredContent: data,
  isError,
});
const image = (png: Uint8Array, data: Record<string, unknown>) => ({
  content: [
    { type: 'image' as const, data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
    { type: 'text' as const, text: JSON.stringify(data) },
  ],
  structuredContent: data,
  isError: false,
});
type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };
// The error code a result gives the agent, for its record: a code of ours, or tool_error for another failure
// (a timed-out command, a CDP error), never free text.
const errorCode = (output: ToolResult) => {
  const code = output.structuredContent?.error;
  return typeof code === 'string' && /^[a-z][a-z_]{0,39}$/.test(code) ? code : 'tool_error';
};
// Wraps a tool's handler to record the call (tool-calls.ts): its timing, outcome, and the step it failed at,
// never its arguments or results. The session is the one the result names, or else the one the call passed.
const recordCalls =
  (db: Database, principal: McpPrincipal, member: Member) =>
  <Args extends object, Rest extends unknown[], R extends ToolResult>(
    tool: string,
    handler: (args: Args, ...rest: Rest) => Promise<R>,
  ) =>
  async (args: Args, ...rest: Rest): Promise<R> => {
    const startedAt = new Date();
    const trace: ToolTrace = { step: null, errorClass: null };
    let output: R | undefined;
    try {
      output = await withToolTrace(trace, () => handler(args, ...rest));
      return output;
    } catch (error) {
      trace.errorClass ??= errorLabel(error);
      throw error;
    } finally {
      const named = output?.structuredContent?.session_id ?? ('session_id' in args ? args.session_id : null);
      await recordToolCall(db, {
        member,
        clientId: principal.clientId,
        tool,
        sessionId: typeof named === 'string' ? named : null,
        startedAt,
        endedAt: new Date(),
        error: !output ? 'internal_error' : output.isError ? errorCode(output) : null,
        trace,
      });
    }
  };
const failure = (value: ComputerFailure, extra: Record<string, unknown> = {}) =>
  result(
    {
      ...extra,
      error: value.error,
      message: value.message,
      ...(value.busyUntil ? { busy_until: value.busyUntil.toISOString() } : {}),
      ...(value.resetsAt ? { resets_at: value.resetsAt.toISOString() } : {}),
    },
    true,
  );
// Any shape is accepted here: the services answer an unknown or malformed ID with session_not_found, which
// tells the agent to call computer_open, where a schema error would not. computer_id likewise gets computer_not_found.
const sessionId = z.string().max(100).describe('The session_id returned by computer_open.');
const computerId = z.string().max(100).describe('The computer_id returned by an earlier computer_open.');
// The user's browser profiles, as the tools report them.
const profileOf = (profile: Profile) => ({
  profile_id: profile.id,
  browser: profile.browser,
  platform: profile.platform,
  last_synced_at: profile.lastSyncedAt,
  default: profile.default,
});
const UNUSED_DAYS = FORK_UNUSED_MS / (24 * 3600_000);
const remote = 'Runs on a cloud computer signed in as the user, never on your own machine.';
const ACT_MAX_TYPED = 2000;
// Expected run time, so a batch stops before it overruns the call budget (computer-timing.ts).
const actCost = (action: ComputerAction) =>
  action.type === 'type'
    ? action.text.length * TYPE_KEY_DELAY_MS
    : action.type === 'wait'
      ? action.ms
      : ACT_ACTION_ESTIMATE_MS;
const plural = (count = 0, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const sites = (sync: SyncSummary) => sync.sites?.join(', ') ?? '';
// email is the connected account: with no sync, the user's extension may sync a different one of their accounts.
function syncNote(sync: SyncSummary, email: string) {
  switch (sync.status) {
    case 'none':
      return `No browser has synced to the Clutchbox account ${email} yet, so no sites are signed in on this computer. If the user expected signed-in sites, tell them you are connected as ${email}: their Clutchbox browser extension may be signed in to a different account. They can sign the extension in to ${email}, or reconnect you under the extension's account.`;
    case 'unchanged':
      return `Browser sign-ins are current with the user's browser as of ${sync.captureCompletedAt}.`;
    case 'applied':
      return `Synced the user's browser from ${sync.captureCompletedAt}: ${plural(sync.sitesUpdated, 'site')} updated.`;
    case 'cleared':
      return `The user stopped syncing their browser to ${email}, so this computer was signed out of the sites it had synced: ${sites(sync)}. If the user expected signed-in sites, tell them to sync their browser again with the Clutchbox extension.`;
    case 'failed':
      return sync.sites
        ? `The user stopped syncing their browser to ${email}, but signing this computer out of the sites it had synced failed this time, so these may still be signed in: ${sites(sync)}. The next computer_open retries.`
        : 'Browser sync failed this time; sites keep their previous sign-ins on the computer. The next computer_open retries.';
  }
}
// The credit in the deployment's words (hooks.ts, Usage): how much is left, when it resets, and whether time past it
// is refused or charged. Without a credit, nothing.
const credit = async (metering: Metering, db: Database, member: Member) => {
  const usage = await metering.usage(db, member, new Date());
  return usage
    ? {
        credit: {
          left: usage.creditLeft,
          resets_at: usage.resetsAt.toISOString(),
          when_used_up: usage.hardStop ? 'refused' : 'charged',
        },
      }
    : {};
};
// Server instructions (MCP initialize): when to use a computer, computers and the computer session flow, and the account.
const instructions = (
  email: string,
) => `Clutchbox gives you a cloud computer signed in as the user: a Linux desktop with Chrome, signed in to the sites the user syncs from their browser. Use it instead of your host environment when a task needs the user's signed-in websites, a real desktop browser, or isolation from your host. Nothing runs on your machine.

You are connected as the Clutchbox account ${email}. Each account's computers are signed in to the sites synced from the browser extension under that same account. When the user asks which account you use, or expected sites are signed out, name it.

Computers: computer_open without computer_id creates a computer for you, a copy of the user's own with their newest sign-ins, and returns its computer_id. Keep it: computer_open with that computer_id reopens it later, from this or another conversation, with its tabs and files as you left them and the user's newest sign-ins applied. computer_open also lists the account's other computers. Computers unused for ${UNUSED_DAYS} days are deleted. Nothing you do on one reaches the user's own computer or browser.

Tools: for websites, prefer browser: snapshot reads the page as text with element refs, and click, type, and select act on a ref and return the page after. Use computer_act, the desktop's mouse and keyboard with a screenshot, for what the page text doesn't show, such as canvas apps, or to see the screen; computer_act with no actions only takes a screenshot. Use computer_exec for files the browser downloaded.

Profiles: each browser the user syncs is its own profile on the computer, with that browser's sign-ins, so a site can be signed in as a different person in each, such as a work and a personal account. A computer session uses one profile. computer_open returns the profiles (profile_id, browser, platform, last_synced_at, default); pass profile_id as profile to computer_open to use one. Without it, a computer you reopen keeps the profile it had, and a new one gets the default, the browser the user synced last. When the user names an account or browser, pick its profile; when unsure which signed-in identity a task needs, ask.

Flow: computer_open returns a session_id. Pass it on every other computer tool call for the task. Each computer_open returns a new session_id that replaces the one you passed it; use the newest from then on. When the task is done, always call computer_close with it: that pauses the computer and refunds unused time.

- session_ended: the session was closed, replaced by your own later computer_open (use the session_id that returned), idle for 10 minutes, or superseded by another agent's computer_open after it sat idle for a minute. Call computer_open with your computer_id for a new session_id and look at the screen before continuing.
- busy: another agent is using that computer. Its control lapses after 1 idle minute (busy_until); try again then, or call computer_open without computer_id for a computer of your own. Yours lapses the same way. busy can also mean every computer the user's organization may run at once is running, until busy_until. Without busy_until, the user is controlling the computer in live view; try again in a few minutes.
- user_in_control: the user took control of the computer in live view, often to sign in or pass a bot check for you, and your session waits for them. Keep your session_id and retry in a minute or two; do not call computer_open. When they hand it back, a result carries user_had_control: take a screenshot before acting, since the screen may have changed.
- computer_not_found: no such computer for this account, or it was deleted. Pick one from computers in computer_open's result, or call computer_open without computer_id.
- profile_not_found: that browser no longer syncs to this account. Pick another from profiles, or omit profile.
- access_revoked: the user disconnected this agent. credit_exhausted: the account's computer credit is used up; its message says until when.
- Never type passwords or other credentials. If a site needs sign-in, follow sign_in_help from computer_open.`;

// The computer tools, for personal use and demos (developers use the REST API). Each call verifies the live grant
// (protectedHandler), and every tool after computer_open runs within the caller's computer session.
function registerComputerTools(
  server: McpServer,
  {
    db,
    computers,
    origin,
    principal,
    member,
    security,
    recorded,
  }: {
    db: Database;
    computers: Computers;
    origin: string;
    principal: McpPrincipal;
    member: Member;
    security: Record<string, unknown>;
    recorded: ReturnType<typeof recordCalls>;
  },
) {
  const signInHelp = `If a site needs sign-in, never type credentials. Ask the user to sign in to it in their own Chrome, add the site in the Clutchbox extension if it is not added, choose Sync now, and tell you when they are done. Then call computer_open with your session_id to apply it, and use the new session_id it returns. Setup is at ${origin}/app.`;
  const caller: Caller = {
    ...member,
    clientId: principal.clientId,
    guard: tx => grantIsLive(tx, principal),
  };
  // A thrown failure: the organization's own provider account refusing it (accountRefusal), or else no answer.
  const unavailable = (extra: Record<string, unknown> = {}, error?: unknown) => {
    const refused = accountRefusal(error);
    if (refused) return failure(refused, extra);
    return result(
      {
        ...extra,
        error: 'computer_unavailable',
        message:
          'The computer did not respond. Take a screenshot before repeating any action that may already have run.',
      },
      true,
    );
  };
  // Every result within a computer session names it and carries the hand-back notice, if any: said once, in the next
  // call's result, or a reopen's.
  const handBack = (handle: Pick<SessionHandle, 'userHadControl'>) =>
    handle.userHadControl
      ? {
          user_had_control: {
            message:
              'The user had control of the computer in live view since your last call. Take a screenshot before acting: the screen may have changed.',
          },
        }
      : {};
  const state = (handle: SessionHandle) => ({ session_id: handle.sessionId, ...handBack(handle) });
  const run = async (
    id: string,
    work: (handle: SessionHandle, deadline: number) => Promise<ReturnType<typeof result> | ReturnType<typeof image>>,
  ) => {
    const deadline = Date.now() + CALL_BUDGET_MS;
    let handle: SessionHandle | undefined;
    try {
      const found = await useComputerSession(db, computers, caller, id);
      if ('error' in found) return failure(found);
      handle = found;
      return await work(handle, deadline);
    } catch (error) {
      toolCallFailed('mcp tool', error);
      return unavailable(handle ? state(handle) : {}, error);
    } finally {
      // Ends the call: the computer pauses after the idle minute.
      await handle?.done();
    }
  };
  const full = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  server.registerTool(
    'computer_open',
    {
      title: 'Open a computer',
      description: `Start a computer session on a remote desktop computer with the user's newest browser sign-ins applied. Without computer_id, creates a new computer for you, a copy of the user's own; with the computer_id of one of the account's computers (from an earlier computer_open), reopens it as it was left, resuming it if paused. The session uses one of the user's browser profiles: the one named by profile, else the one the computer had, else the browser the user synced last. Returns session_id, which every other computer tool requires, computer_id, the profile used and all profiles, the account's other computers, and a screenshot. Pass your current session_id to replace it with a fresh session on the same computer without losing control, for example to apply a sign-in the user just synced, and use the new session_id from then on; without it, another active session on that computer (even your own) makes this return busy until its idle minute ends. To open a page, use browser with action navigate. Call computer_close when the task is done. ${remote} ${signInHelp}`,
      inputSchema: z
        .object({
          session_id: sessionId.optional().describe('Your current session_id, if you have one.'),
          computer_id: computerId.optional().describe('The computer to reopen; omit it for a new computer.'),
          profile: z
            .string()
            .max(100)
            .optional()
            .describe(
              "The profile_id of the user's browser profile to use, from profiles in an earlier computer_open. Omit it to keep the computer's profile, or for a new computer, the browser synced last.",
            ),
          label: z
            .string()
            .trim()
            .min(1)
            .max(100)
            .optional()
            .describe(
              "For a new computer: a short name for its task, shown in later computer_open results' computers.",
            ),
        })
        .strict(),
      annotations: full,
      _meta: security,
    },
    recorded('computer_open', async ({ session_id, computer_id, label, profile }) => {
      let handle: SessionHandle | undefined;
      try {
        const opened = await openComputerSession(db, computers, caller, {
          sessionId: session_id,
          computerId: computer_id,
          label,
          profile,
        });
        if ('error' in opened) return failure(opened);
        handle = opened;
        // An agent opened a computer: the user is set up. Best-effort; never fails the open.
        await noteSetupStep(db, member, 'setUp');
        markToolStep('screenshot');
        const png = await opened.session.screenshot();
        // End the call first, so the credit counts its running time.
        await opened.done();
        const others = (await listForks(db, member)).filter(fork => fork.computerId !== opened.computer.id);
        const price = computers.metering.minutePrice?.(opened.computer.size);
        return image(png, {
          session_id: opened.sessionId,
          computer_id: opened.computer.id,
          ...(opened.computer.label ? { label: opened.computer.label } : {}),
          new_computer: opened.computer.created,
          profile: opened.profile && profileOf(opened.profile),
          profiles: opened.profiles.map(profileOf),
          ...handBack(opened),
          display: DISPLAY,
          idle_pause_seconds: IDLE_PAUSE_MS / 1000,
          account_id: principal.userId,
          account_email: principal.email,
          browser_sync: syncNote(opened.sync, principal.email),
          sign_in_help: signInHelp,
          // On the organization's own account, its provider charges it directly, at its own price.
          runs_on: {
            provider: computers.provider.name,
            account: opened.computer.account,
            size: sizeName(opened.computer.size),
          },
          ...(price && opened.computer.account === 'deployment' ? { price_per_minute: price } : {}),
          live_view_url: `${origin}/app/computer?computer=${opened.computer.id}`,
          computers: others.map(fork => ({
            computer_id: fork.computerId,
            label: fork.label,
            last_used_at: fork.lastUsedAt,
            status: fork.status,
          })),
          ...(await credit(computers.metering, db, member)),
        });
      } catch (error) {
        toolCallFailed('mcp computer_open', error);
        // The session started: name it so the agent can retry within it.
        return unavailable(handle ? { session_id: handle.sessionId } : {}, error);
      } finally {
        await handle?.done();
      }
    }),
  );
  server.registerTool(
    'computer_close',
    {
      title: 'Close the computer session',
      description: `End your computer session when the task is done: pauses the computer and refunds the unused time. The computer keeps its tabs and files; computer_open with its computer_id reopens it. Always call it when you finish with the computer. The session_id stops working. ${remote}`,
      inputSchema: z.object({ session_id: sessionId }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: security,
    },
    recorded('computer_close', async ({ session_id }) => {
      try {
        const closed = await closeComputerSession(db, computers, caller, session_id);
        if ('error' in closed) return failure(closed);
        return result({ closed: true, ...(await credit(computers.metering, db, member)) });
      } catch (error) {
        toolCallFailed('mcp computer_close', error);
        return unavailable({}, error);
      }
    }),
  );
  server.registerTool(
    'computer_act',
    {
      title: "Use the computer's mouse and keyboard",
      description: `Perform up to 20 mouse/keyboard actions in order on the desktop: click, move, drag, scroll, type, key (for example "Return" or ["ctrl", "l"]), or wait; with no actions, only take a screenshot. Coordinates are screenshot pixels. For websites, browser is usually faster. One call types at most ${ACT_MAX_TYPED} characters and waits at most ${ACT_MAX_WAIT_MS / 1000} seconds in total. Stops at the first failure, or when the call runs out of time, and reports what ran; send unexecuted actions in a new call. Returns a screenshot. Actions affect real signed-in accounts. ${remote}`,
      inputSchema: z
        .object({
          session_id: sessionId,
          actions: z
            .array(actionSchema)
            .max(20)
            .default([])
            .refine(
              actions =>
                actions.reduce((sum, action) => sum + (action.type === 'type' ? action.text.length : 0), 0) <=
                ACT_MAX_TYPED,
              `Type at most ${ACT_MAX_TYPED} characters per call.`,
            )
            .refine(
              actions =>
                actions.reduce((sum, action) => sum + (action.type === 'wait' ? action.ms : 0), 0) <= ACT_MAX_WAIT_MS,
              `Wait at most ${ACT_MAX_WAIT_MS} ms per call.`,
            ),
        })
        .strict(),
      annotations: full,
      _meta: security,
    },
    recorded('computer_act', ({ session_id, actions }) =>
      run(session_id, async (handle, deadline) => {
        if (actions.length) markToolStep('act');
        let completed = 0;
        let failed: string | undefined;
        let stopped: string | undefined;
        for (const action of actions) {
          if (Date.now() + actCost(action) > deadline) {
            stopped = 'Time budget reached; send the unexecuted actions in a new call.';
            break;
          }
          try {
            await handle.session.act(action);
            completed++;
          } catch {
            failed = `Action ${completed} (${action.type}) failed.`;
            break;
          }
        }
        markToolStep('screenshot');
        return image(await handle.session.screenshot(), {
          ...state(handle),
          display: DISPLAY,
          completed,
          unexecuted: actions.length - completed - (failed ? 1 : 0),
          ...(failed ? { failed } : {}),
          ...(stopped ? { stopped } : {}),
        });
      }),
    ),
  );
  server.registerTool(
    'browser',
    {
      title: "Use the computer's browser",
      description: `Read and act on web pages in the computer's Chrome, the browser shown on screen, by text instead of screenshots. Actions: snapshot (the tab's elements as text, each with a ref such as e42), navigate (url), click (ref), type (ref and text, replacing what the field holds; submit to press Enter), select (ref and value), tabs, tab_open (url), tab_activate and tab_close (target_id), evaluate (expression: JavaScript run in the page, returning its value), and cdp (method and params: one raw Chrome DevTools Protocol command, sent to the browser unless target_id names a tab). navigate, click, type, select, tab_open, and tab_activate return the page's new snapshot. Refs last until the page changes; take a new snapshot when one is stale. Without target_id, actions use the tab on screen, and results name its target_id. Actions affect real signed-in accounts. ${remote}`,
      inputSchema: z.object({ session_id: sessionId, ...browserInput }).strict(),
      annotations: full,
      _meta: security,
    },
    recorded('browser', ({ session_id, ...input }) =>
      run(session_id, async (handle, deadline) => {
        const missing = missingInput(input);
        if (missing?.length)
          return result(
            { ...state(handle), error: 'invalid_input', message: `${input.action} needs ${missing.join(' and ')}.` },
            true,
          );
        markToolStep('cdp');
        try {
          return result({ ...state(handle), ...(await browserAction(handle.session, input, deadline)) });
        } catch (error) {
          if (!(error instanceof BrowserError)) throw error;
          return result({ ...state(handle), error: error.code, message: error.message }, true);
        }
      }),
    ),
  );
  server.registerTool(
    'computer_exec',
    {
      title: 'Run a command on the computer',
      description: `Run one non-interactive shell command as the desktop user on the remote Linux computer and return its exit code and output (each capped at 32 KB). Use it to inspect or process files the browser downloaded (usually in /home/user/Downloads). timeout_seconds is at most ${EXEC_MAX_SECONDS}; run longer jobs in the background and check on them. ${remote}`,
      inputSchema: z
        .object({
          session_id: sessionId,
          command: z.string().min(1).max(8000),
          cwd: z.string().regex(/^\//).max(500).optional(),
          timeout_seconds: z.int().min(1).max(EXEC_MAX_SECONDS).default(30),
        })
        .strict(),
      annotations: full,
      _meta: security,
    },
    recorded('computer_exec', ({ session_id, command, cwd, timeout_seconds }) =>
      run(session_id, async (handle, deadline) => {
        markToolStep('exec');
        // A slow resume eats into the budget; the command then times out (timed_out) instead of the platform's 504.
        const effective = Math.max(1, Math.min(timeout_seconds, Math.floor((deadline - Date.now()) / 1000)));
        const output = await handle.session.exec({ command, cwd, timeoutSeconds: effective });
        return result(
          {
            ...state(handle),
            exit_code: output.exitCode,
            stdout: output.stdout,
            stderr: output.stderr,
            truncated: output.truncated,
            timed_out: output.timedOut,
            ...(effective < timeout_seconds ? { timeout_seconds: effective } : {}),
          },
          output.timedOut,
        );
      }),
    ),
  );
}

export function createMcpEndpoint({
  db,
  auth,
  origin,
  computers,
  hooks = defaultServerHooks,
}: {
  db: Database;
  auth: Auth;
  origin: string;
  computers: ComputerProvider;
  hooks?: Pick<ServerHooks, 'metering' | 'operatorAdmin'> & Partial<Pick<ServerHooks, 'limits' | 'providerAccount'>>;
}) {
  const resource = `${origin}/api/mcp`;
  const serve = (request: Request, principal: McpPrincipal, member: Member) =>
    createMcpHandler(
      () => {
        const server = new McpServer(
          { name: 'clutchbox', version: '0.6.0' },
          { instructions: instructions(principal.email) },
        );
        const security = { securitySchemes: [{ type: 'oauth2', scopes: [MCP_SCOPE] }] };
        const recorded = recordCalls(db, principal, member);
        registerComputerTools(server, {
          db,
          computers: {
            provider: computers,
            metering: hooks.metering,
            ...(hooks.limits && { limits: hooks.limits }),
            ...(hooks.providerAccount && { accounts: hooks.providerAccount }),
          },
          origin,
          principal,
          member,
          security,
          recorded,
        });
        return server;
      },
      { legacy: 'stateless', onerror: error => logError('mcp transport', error) },
    ).fetch(request);
  const protectedHandler = requireMcpAuth(
    auth,
    async (request, claims) => {
      const principal = await liveMcpPrincipal(db, claims);
      if (principal) await hooks.operatorAdmin.recordActivity(db, principal.userId);
      if (!principal)
        return Response.json(
          { error: 'invalid_grant' },
          {
            status: 401,
            headers: {
              'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`,
            },
          },
        );
      // Every call acts as the member the grant is for (server/src/mcp.ts).
      await noteAgentConnected(db, principal.member);
      return serve(request, principal, principal.member);
    },
    { resource, requiredScopes: [MCP_SCOPE] },
  );
  return async (request: Request) => {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    if (request.headers.has('origin') && request.headers.get('origin') !== origin)
      return new Response(null, { status: 403 });
    const contentLength = Number(request.headers.get('content-length'));
    if (contentLength > 65_536) return new Response(null, { status: 413 });
    const raw = await request.clone().text();
    if (raw.length > 65_536) return new Response(null, { status: 413 });
    try {
      JSON.parse(raw);
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 });
    }
    // Challenge even initialization and tool discovery so clients detect OAuth during setup.
    const response = await protectedHandler(request);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  };
}
