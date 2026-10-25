// Every timing that governs computers, computer sessions, MCP tool calls, and apply-on-open, in one place.
// Each value says what it bounds and how it was chosen; values derived from others say so in code, so
// changing one keeps the rest consistent. Extension capture timings are server-sent config instead
// (defaultExtensionConfig in packages/capture).

// The E2B adapter's command timings live with it (@agent-computers/e2b/timing), clamped to
// the budgets set here. These are the ones this service uses too.
export {
  DOWNLOAD_LINK_SECONDS,
  STREAM_MARGIN_MS,
  STREAM_START_MS,
  TYPE_KEY_DELAY_MS,
} from '@agent-computers/e2b/timing';

// --- Computer sessions and control ---

// Control lapses and the computer pauses this long after a computer session's last call ends. E2B resumes a
// paused computer in about a second, so a short idle costs little latency, while it keeps billing close to
// running time and lets another agent take over quickly.
export const IDLE_PAUSE_MS = 60_000;

// A computer session idle this long is ended, and its session_id then gets session_ended. Long enough to
// cover an agent thinking, or waiting on the user, between calls; short enough that a remembered session_id
// from an old conversation stops working.
export const SESSION_IDLE_END_MS = 10 * 60_000;

// A computer still `creating` after this long is presumed abandoned (its request died), and the next
// computer_open takes the create over. Creating takes well under it: E2B create plus the adapter's ENSURE_CHROME_MS.
export const CREATE_STALE_MS = 3 * 60_000;

// --- Live view holds (computers.ts) ---

// How often the /computer page's heartbeat reports its lease while visible (useHeartbeat in the web app's API
// client), and how often the relay re-reads the user's control. A judgment call: input stops within a few seconds of a
// hand-back, at one small request per beat.
export const HEARTBEAT_MS = 3_000;

// A watch or takeover lapses this long after the page's last visible heartbeat or its hidden report: the page
// crashed, slept, or lost its network without a release. One minute: the same as an
// agent's idle minute (IDLE_PAUSE_MS), and twenty beats, so a few lost heartbeats never end a hold.
export const HOLD_LAPSE_MS = 60_000;

// A visible heartbeat extends a hold only once less than HOLD_LAPSE_MS is left, and then by this much more, so
// the database row, the charge ahead, and the provider timeout are written about every 5 beats, not every beat.
// A hold therefore lapses (HOLD_LAPSE_MS, HOLD_LAPSE_MS + HOLD_EXTEND_STEP_MS] after the last heartbeat.
export const HOLD_EXTEND_STEP_MS = 5 * HEARTBEAT_MS;

// A released lease is remembered this long, so a visible heartbeat the page sent just before it closed, handled after
// the release, does not start a watch nobody ends until it lapses. A beat takes a round trip, plus a wait for the
// computer row's lock; one still unhandled after a hold's lapse would no longer matter.
export const RELEASED_LEASE_MS = HOLD_LAPSE_MS;

// Live view's paste: writing the text to the computer and running set-clipboard.py, which takes the clipboard in well
// under a second. Bounds POST /api/v1/computer/clipboard's provider work, so a stalled computer fails the paste
// with an error the page shows rather than leaving the user's Cmd+V hanging. A judgment call. The adapter keeps its
// CLIPBOARD_CLEANUP_MS of it for removing the text's file after a failed run.
export const CLIPBOARD_SET_MS = 10_000;

// --- Live view relay (live-view-relay.ts) ---

// Vercel ends the live-view relay's connection at this route limit: the web app's route manifest
// (@agent-computers/web) writes it into the /api/v1/live-view route file as the literal `maxDuration` Next.js needs.
// 300 s is valid on every Vercel plan (Hobby's cap); Pro allows up to 800 s if reconnects every 5 minutes cost
// too much.
export const LIVE_VIEW_MAX_DURATION_MS = 300_000;

// The relay closes this long before LIVE_VIEW_MAX_DURATION_MS, with code 4000 'reconnect', so held keys and
// buttons are released on the computer and the page reconnects on a close it knows, before the platform cuts
// the connection. A judgment call: the releases and close handshakes take well under a second.
export const LIVE_VIEW_CLOSE_MARGIN_MS = 10_000;

// After the relay starts closing, a socket whose peer has not finished the close handshake within this long is
// dropped, so a deadline close still ends inside LIVE_VIEW_CLOSE_MARGIN_MS.
export const LIVE_VIEW_CLOSE_WAIT_MS = LIVE_VIEW_CLOSE_MARGIN_MS / 2;

// The relay re-reads the user's control every HEARTBEAT_MS, and sooner when it drops input (the page took over
// since the last read), but no more often than this, so a takeover's first input waits at most about this long
// plus one query. A judgment call between that delay and database load.
export const LIVE_VIEW_CONTROL_RECHECK_MS = 500;

// The relay pings both sockets this often. Vercel documents no idle timeout for WebSockets but warns that
// HTTP/1.1 intermediaries drop idle connections; a still screen sends nothing for minutes. 30 s is the usual
// interval for that and costs nothing.
export const LIVE_VIEW_PING_MS = 30_000;

// Opening the relay's WebSocket to the computer's websockify once its stream runs (packages/api/src/live-view.ts),
// before the page's connection is upgraded, so a computer that never answers gets a 503 rather than a hang. A
// judgment call: a TLS and WebSocket handshake through E2B's proxy takes well under a second.
export const LIVE_VIEW_UPSTREAM_OPEN_MS = 10_000;

// --- One MCP tool call ---

// Vercel stops an MCP request at 120 s: the web app's route manifest (@agent-computers/web) writes it into the
// /api/mcp and /api/v1 route files as the literal `maxDuration` Next.js needs.
export const ROUTE_MAX_DURATION_MS = 120_000;

// What one tool call may use, counting control, charge, and resume. The 20 s left of the route's limit lets
// the final screenshot and response go out before the platform cuts the request into a 504.
export const CALL_BUDGET_MS = ROUTE_MAX_DURATION_MS - 20_000;

// What each call charges ahead and sets as the provider's timeout. E2B's timeout is wall-clock, not activity
// based, so it must outlast the longest call plus the idle minute; when the call ends, the timeout is cut
// back to IDLE_PAUSE_MS and the rest is refunded (computers.ts, finishCall).
export const CALL_HOLD_MS = CALL_BUDGET_MS + IDLE_PAUSE_MS;

// Tool call records (tool-calls.ts) are deleted this long after the call started. A judgment call: long enough
// to look back over a month or two of usage and failures, short enough not to keep a history nobody reads.
export const TOOL_CALL_RETENTION_MS = 90 * 24 * 3600_000;

// --- Tool limits (packages/api/src/mcp.ts) ---

// The most computer_exec accepts for timeout_seconds. 10 s under CALL_BUDGET_MS leaves room for control,
// charge, and resume; a slow resume clamps it further to what is left of the budget.
export const EXEC_MAX_SECONDS = 90;

// Total `wait` time one computer_act call accepts. A judgment call: long enough for page loads between
// actions, and well inside CALL_BUDGET_MS alongside typing.
export const ACT_MAX_WAIT_MS = 30_000;

// computer_act's run-time estimate for any action but `type` and `wait`. Rough: an xdotool round trip to
// E2B takes well under a second.
export const ACT_ACTION_ESTIMATE_MS = 1_000;

// computer_close's best-effort tab cleanup gives up after this long, after the apply's SYNC_DEADLINE_MS, still
// inside CALL_BUDGET_MS. It is a few CDP commands that normally take well under a second each; a Chrome that
// slow is left as it is for the next close.
export const CLOSE_TABS_MS = 10_000;

// --- Refresh on open (computers.ts, refreshComputer) ---

// Bringing a computer made from an older template to the current helpers and restarting Chrome on them, on
// computer_open before the apply, which then has what is left of SYNC_DEADLINE_MS (at least 35 s of its
// SYNC_BUDGET_MS). Runs once per helper change per computer, so a slow one is rare and is retried next open.
export const REFRESH_BUDGET_MS = 30_000;

// --- Apply-on-open (computers.ts, applyLatestCapture) ---

// An apply on computer_open or computer_close must finish, or give up, this long after the call starts.
// Leaves 25 s of CALL_BUDGET_MS for the screenshot, or for CLOSE_TABS_MS.
export const SYNC_DEADLINE_MS = 75_000;

// The most time the provider may spend applying cookies. It must fit the steps in the E2B adapter's SYNC_STEP_MS that can
// run in sequence, minus what normally runs fast; capped further by what is left before SYNC_DEADLINE_MS.
export const SYNC_BUDGET_MS = 45_000;

// Backstop past the provider's budget (covering its payload clean-up) before the open stops waiting on a
// stuck provider call. The provider bounds its own work, so this only matters when it fails to.
export const SYNC_SLACK_MS = 10_000;

// With less budget than this left, the apply is skipped and retried on the next open: too little time to
// clear and re-set cookies, and starting would sign the synced sites out.
export const SYNC_MIN_MS = 10_000;
