import 'server-only';
import type { Auth } from '@agent-computers/server/auth';
import {
  ACT_ACTION_ESTIMATE_MS,
  ACT_MAX_WAIT_MS,
  CALL_BUDGET_MS,
  DOWNLOAD_LINK_SECONDS,
  EXEC_MAX_SECONDS,
  IDLE_PAUSE_MS,
  TYPE_KEY_DELAY_MS,
} from '@agent-computers/server/computer-timing';
import {
  actionSchema,
  type Caller,
  type ComputerAction,
  type ComputerFailure,
  type ComputerProvider,
  type Computers,
  closeComputerSession,
  DISPLAY,
  openComputerSession,
  type SessionHandle,
  type SyncSummary,
  useComputerSession,
} from '@agent-computers/server/computers';
import type { Database } from '@agent-computers/server/database';
import { defaultServerHooks, type Metering, type ServerHooks } from '@agent-computers/server/hooks';
import { errorLabel, logError } from '@agent-computers/server/log';
import { grantIsLive, liveMcpPrincipal, MCP_SCOPE, type McpPrincipal } from '@agent-computers/server/mcp';
import type { Member } from '@agent-computers/server/organizations';
import { noteAgentConnected, noteSetupStep } from '@agent-computers/server/setup';
import {
  markToolStep,
  recordToolCall,
  type ToolTrace,
  toolCallFailed,
  withToolTrace,
} from '@agent-computers/server/tool-calls';
import { requireMcpAuth } from '@better-auth/mcp';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

// The remote MCP endpoint (/api/mcp): OAuth-protected transport and the computer tools,
// presented over the grant and main computer modules in packages/server.
const result = (data: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  structuredContent: data,
  isError,
});
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
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
  <Args extends { session_id?: string | undefined }, Rest extends unknown[], R extends ToolResult>(
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
      const named = output?.structuredContent?.session_id ?? args.session_id;
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
const failure = (value: ComputerFailure) =>
  result(
    {
      error: value.error,
      message: value.message,
      ...(value.busyUntil ? { busy_until: value.busyUntil.toISOString() } : {}),
      ...(value.resetsAt ? { resets_at: value.resetsAt.toISOString() } : {}),
    },
    true,
  );
// Any shape is accepted here: the services answer an unknown or malformed ID with session_not_found, which
// tells the agent to call computer_open, where a schema error would not.
const sessionId = z.string().max(100).describe('The session_id returned by computer_open.');
const remote = "Runs on the user's remote Agent Computers desktop, never on your own machine.";
const ACT_MAX_TYPED = 2000;
// Expected run time, so a batch stops before it overruns the call budget (computer-timing.ts).
const actCost = (action: ComputerAction) =>
  action.type === 'type'
    ? action.text.length * TYPE_KEY_DELAY_MS
    : action.type === 'wait'
      ? action.ms
      : ACT_ACTION_ESTIMATE_MS;
const plural = (count = 0, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
// email is the connected account: with no sync, the user's extension may sync a different one of their accounts.
function syncNote(sync: SyncSummary, email: string) {
  switch (sync.status) {
    case 'none':
      return `No browser has synced to the Agent Computers account ${email} yet, so no sites are signed in on this computer. If the user expected signed-in sites, tell them you are connected as ${email}: their Agent Computers browser extension may be signed in to a different account. They can sign the extension in to ${email}, or reconnect you under the extension's account.`;
    case 'unchanged':
      return `Browser sign-ins are current with the user's browser as of ${sync.captureCompletedAt}.`;
    case 'applied':
      return `Synced the user's browser from ${sync.captureCompletedAt}: ${plural(sync.sitesUpdated, 'site')} updated.`;
    case 'failed':
      return 'Browser sync failed this time; sites keep their previous sign-ins on the computer. The next computer_open retries.';
    case 'pending':
      return `The computer was already paused, so the user's browser from ${sync.captureCompletedAt} was not applied; the next computer_open applies it.`;
  }
}
// Without an allowance (hooks.ts), nothing.
const freeMinutes = async (metering: Metering, db: Database, member: Member) => {
  const usage = await metering.usage(db, member, new Date());
  return usage
    ? {
        free_minutes_remaining: Math.floor(usage.remainingSeconds / 60),
        free_minutes_reset_at: usage.resetsAt.toISOString(),
      }
    : {};
};
// Server instructions (MCP initialize): when to use the computer, the computer session flow, and the account.
const instructions = (
  email: string,
) => `Agent Computers gives you the user's own remote computer: a Linux desktop with Chrome, signed in to the sites the user syncs from their browser. Use it instead of your host environment when a task needs the user's signed-in websites, a real desktop browser, or isolation from your host. Nothing runs on your machine.

You are connected as the Agent Computers account ${email}. Each account has its own computer, signed in to the sites synced from the browser extension under that same account. When the user asks which account you use, or expected sites are signed out, name it.

Flow: computer_open returns a session_id. Pass it on every other computer tool call for the task. Each computer_open returns a new session_id that replaces the one you passed it; use the newest from then on. When the task is done, always call computer_close with it: that applies newer browser sign-ins, closes the browser tabs, pauses the computer, and refunds unused time.

- session_ended: the session was closed, replaced by your own later computer_open (use the session_id that returned), idle for 10 minutes, or superseded by another agent's computer_open after it sat idle for a minute. Call computer_open for a new session_id and take a screenshot before continuing.
- busy: another agent is using the computer. Its control lapses after 1 idle minute (busy_until); try again then. Yours lapses the same way. Without busy_until, the user is controlling the computer in live view; try again in a few minutes.
- user_in_control: the user took control of the computer in live view, often to sign in or pass a bot check for you, and your session waits for them. Keep your session_id and retry in a minute or two; do not call computer_open. When they hand it back, a result carries user_had_control: take a screenshot before acting, since the screen may have changed.
- pending_sync in a result: the user signed in or out of the named sites in their browser. Call computer_open with your session_id to apply it; you keep control under the new session_id it returns.
- access_revoked: the user disconnected this agent. allowance_exhausted: the account's computer time is used up; its message says until when.
- Never type passwords or other credentials. If a site needs sign-in, follow sign_in_help from computer_open.`;

// Real computer tools for the validation prototype. Each call verifies the live grant (protectedHandler),
// and every tool after computer_open runs within the caller's computer session.
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
  const signInHelp = `If a site needs sign-in, never type credentials. Ask the user to sign in to it in their own Chrome, add the site in the Agent Computers extension if it is not added, choose Sync now, and tell you when they are done. A waiting sign-in then shows as pending_sync in tool results; call computer_open with your session_id to apply it, and use the new session_id it returns. Setup is at ${origin}/app.`;
  const caller: Caller = {
    ...member,
    clientId: principal.clientId,
    guard: tx => grantIsLive(tx, principal),
  };
  const unavailable = (extra: Record<string, unknown> = {}) =>
    result(
      {
        ...extra,
        error: 'computer_unavailable',
        message:
          'The computer did not respond. Take a screenshot before repeating any action that may already have run.',
      },
      true,
    );
  // Every result within a computer session names it and carries the pending and hand-back notices, if any.
  // After a hand-back, said once: in the next call's result, or a reopen's.
  const handBack = (handle: Pick<SessionHandle, 'userHadControl'>) =>
    handle.userHadControl
      ? {
          user_had_control: {
            message:
              'The user had control of the computer in live view since your last call. Take a screenshot before acting: the screen may have changed.',
          },
        }
      : {};
  const state = (handle: SessionHandle) => ({
    session_id: handle.sessionId,
    ...handBack(handle),
    ...(handle.pending
      ? {
          pending_sync: {
            sites: handle.pending.sites,
            message: `Newer sign-ins or sign-outs from the user's browser are waiting for ${handle.pending.sites.join(', ')}. To apply them, call computer_open with this session_id; you keep control under the new session_id it returns.`,
          },
        }
      : {}),
  });
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
      return unavailable(handle ? state(handle) : {});
    } finally {
      // Ends the call: the computer pauses after the idle minute.
      await handle?.done();
    }
  };
  const full = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  server.registerTool(
    'computer_open',
    {
      title: "Open the user's Agent Computer",
      description: `Open the user's persistent remote desktop computer (created on first use, resumed if paused), apply the user's newest browser sign-ins, and start a computer session for this agent. Returns session_id, which every other computer tool requires, plus a screenshot. Pass your current session_id to replace it with a fresh session without losing control, for example to apply pending_sync, and use the new session_id from then on; without it, another active session (even your own) makes this return busy until its idle minute ends. To open a page, use computer_act: key ["ctrl", "l"], type the URL, key "enter". Call computer_close when the task is done. ${remote} ${signInHelp}`,
      inputSchema: z
        .object({
          session_id: sessionId.optional().describe('Your current session_id, if you have one.'),
        })
        .strict(),
      annotations: full,
      _meta: security,
    },
    recorded('computer_open', async ({ session_id }) => {
      let handle: SessionHandle | undefined;
      try {
        const opened = await openComputerSession(db, computers, caller, { sessionId: session_id });
        if ('error' in opened) return failure(opened);
        handle = opened;
        // An agent opened the computer: the user is set up. Best-effort; never fails the open.
        await noteSetupStep(db, member, 'setUp');
        markToolStep('screenshot');
        const png = await opened.session.screenshot();
        // End the call first, so the free minutes count its running time.
        await opened.done();
        return image(png, {
          session_id: opened.sessionId,
          ...handBack(opened),
          display: DISPLAY,
          idle_pause_seconds: IDLE_PAUSE_MS / 1000,
          account_email: principal.email,
          browser_sync: syncNote(opened.sync, principal.email),
          sign_in_help: signInHelp,
          ...(await freeMinutes(computers.metering, db, member)),
        });
      } catch (error) {
        toolCallFailed('mcp computer_open', error);
        // The session started: name it so the agent can retry within it.
        return unavailable(handle ? { session_id: handle.sessionId } : {});
      } finally {
        await handle?.done();
      }
    }),
  );
  server.registerTool(
    'computer_close',
    {
      title: 'Close the computer session',
      description: `End your computer session when the task is done: applies the user's newest browser sign-ins, closes the browser tabs (leaving one blank tab), pauses the computer, and refunds the unused time. Always call it when you finish with the computer. The session_id stops working; call computer_open to use the computer again. ${remote}`,
      inputSchema: z.object({ session_id: sessionId }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: security,
    },
    recorded('computer_close', async ({ session_id }) => {
      try {
        const closed = await closeComputerSession(db, computers, caller, session_id);
        if ('error' in closed) return failure(closed);
        return result({
          closed: true,
          browser_sync: syncNote(closed.sync, principal.email),
          ...(await freeMinutes(computers.metering, db, member)),
        });
      } catch (error) {
        toolCallFailed('mcp computer_close', error);
        return unavailable();
      }
    }),
  );
  server.registerTool(
    'computer_screenshot',
    {
      title: 'Screenshot the Agent Computer',
      description: `Capture the current screen of the remote computer. Coordinates in other tools use these screenshot pixels. ${remote}`,
      inputSchema: z.object({ session_id: sessionId }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: security,
    },
    recorded('computer_screenshot', ({ session_id }) =>
      run(session_id, async handle => {
        markToolStep('screenshot');
        return image(await handle.session.screenshot(), { ...state(handle), display: DISPLAY });
      }),
    ),
  );
  server.registerTool(
    'computer_act',
    {
      title: "Use the Agent Computer's mouse and keyboard",
      description: `Perform up to 20 mouse/keyboard actions in order on the remote desktop: click, move, drag, scroll, type, key (for example "enter" or ["ctrl", "l"]), or wait. One call types at most ${ACT_MAX_TYPED} characters and waits at most ${ACT_MAX_WAIT_MS / 1000} seconds in total. Stops at the first failure, or when the call runs out of time, and reports what ran; send unexecuted actions in a new call. Returns a screenshot. Actions affect real signed-in accounts. ${remote}`,
      inputSchema: z
        .object({
          session_id: sessionId,
          actions: z
            .array(actionSchema)
            .min(1)
            .max(20)
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
        markToolStep('act');
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
          completed,
          unexecuted: actions.length - completed - (failed ? 1 : 0),
          ...(failed ? { failed } : {}),
          ...(stopped ? { stopped } : {}),
        });
      }),
    ),
  );
  server.registerTool(
    'browser_cdp',
    {
      title: 'Send a Chrome DevTools Protocol command',
      description: `Send one Chrome DevTools Protocol command to the remote computer's Chrome (the same browser shown on screen). Omit target_id for browser-level commands such as Target.getTargets; pass a page target_id for page commands such as Runtime.evaluate. Events are not returned. ${remote}`,
      inputSchema: z
        .object({
          session_id: sessionId,
          method: z.string().regex(/^[A-Z][A-Za-z]+\.[a-zA-Z]+$/),
          params: z.record(z.string(), z.unknown()).optional(),
          target_id: z
            .string()
            .regex(/^[A-Fa-f0-9]{32}$/)
            .optional(),
        })
        .strict(),
      annotations: full,
      _meta: security,
    },
    recorded('browser_cdp', ({ session_id, method, params, target_id }) =>
      run(session_id, async handle => {
        markToolStep('cdp');
        const output = await handle.session.cdp({ method, params, targetId: target_id });
        if (output.length > 60_000)
          return result(
            {
              ...state(handle),
              error: 'cdp_result_too_large',
              message: 'Narrow the command (for example return a smaller value from Runtime.evaluate).',
            },
            true,
          );
        let parsed: unknown;
        try {
          parsed = JSON.parse(output || '{"error":"cdp_no_response"}');
        } catch {
          parsed = null;
        }
        // The command may have run; an unreadable reply is a CDP problem, not an unresponsive computer.
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          return result(
            {
              ...state(handle),
              error: 'cdp_invalid_response',
              message:
                'Chrome returned an unreadable reply. Take a screenshot before repeating a command that may already have run.',
            },
            true,
          );
        return result({ ...state(handle), ...parsed }, 'error' in parsed);
      }),
    ),
  );
  server.registerTool(
    'computer_exec',
    {
      title: 'Run a command on the Agent Computer',
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
  server.registerTool(
    'computer_download',
    {
      title: 'Get a download link for a file',
      description: `Create a 15-minute download link for one file on the remote computer so the user can save it, for example a CSV the browser downloaded. Share the link with the user. ${remote}`,
      inputSchema: z.object({ session_id: sessionId, path: z.string().regex(/^\//).max(500) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: security,
    },
    recorded('computer_download', ({ session_id, path }) =>
      run(session_id, async handle => {
        markToolStep('download');
        const size = await handle.session.exec({ command: `stat -c %s -- ${quote(path)}`, timeoutSeconds: 10 });
        if (size.exitCode !== 0)
          return result(
            { ...state(handle), error: 'file_not_found', message: 'No readable file exists at that path.' },
            true,
          );
        return result({
          ...state(handle),
          url: await handle.session.downloadUrl(path),
          expires_in_seconds: DOWNLOAD_LINK_SECONDS,
          size_bytes: Number(size.stdout.trim()),
        });
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
  hooks?: Pick<ServerHooks, 'metering' | 'operatorAdmin'>;
}) {
  const resource = `${origin}/api/mcp`;
  const serve = (request: Request, principal: McpPrincipal, member: Member) =>
    createMcpHandler(
      () => {
        const server = new McpServer(
          { name: 'agent-computers', version: '0.5.0' },
          { instructions: instructions(principal.email) },
        );
        const security = { securitySchemes: [{ type: 'oauth2', scopes: [MCP_SCOPE] }] };
        const recorded = recordCalls(db, principal, member);
        server.registerTool(
          'account_identity',
          {
            title: 'Check connected account',
            description: 'Return the connected Agent Computers account (ID and email).',
            inputSchema: z.object({}).strict(),
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
            _meta: security,
          },
          recorded('account_identity', async (_args, context) => {
            const protocol = request.headers.get('mcp-protocol-version');
            const metadataKeys = Object.keys(context.mcpReq._meta ?? {})
              .filter(key => /^[a-zA-Z0-9_./-]{1,80}$/.test(key))
              .slice(0, 16);
            return result({
              protocol_version: protocol && /^\d{4}-\d{2}-\d{2}$/.test(protocol) ? protocol : 'not_supplied',
              metadata_keys: metadataKeys,
              user_id: principal.userId,
              account_email: principal.email,
              client_id: principal.clientId,
              access_model: 'computer_session',
            });
          }),
        );
        registerComputerTools(server, {
          db,
          computers: { provider: computers, metering: hooks.metering },
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
