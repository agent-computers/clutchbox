// Timings for commands the E2B adapter runs on a computer, each with what it bounds and how its value was chosen. The
// caller's own budgets (how long an open, a call, or an apply may take) belong to the caller; the adapter clamps every
// step to the budget it is given. Values marked "baked into the helper" change REVISION, so they reach existing
// computers through their next refresh.

// Starting live view's stream (x11vnc and websockify, live-view-stream.sh) when it is not already running, and
// waiting for its socket and port. Both normally start in well under a second; this bounds the helper's whole run,
// a concurrent start's lock included, and the command's timeout adds STREAM_MARGIN_MS for the round trip. Baked
// into the helper.
export const STREAM_START_MS = 10_000;
export const STREAM_MARGIN_MS = 5_000;

// Kept back from a clipboard budget for removing the text's file after a failed run.
export const CLIPBOARD_CLEANUP_MS = 2_000;
// set-clipboard.py's wait for its background process to own the clipboard before it reports failure. Taking it is one
// X round trip; this is the headroom for a busy X server. Baked into the helper.
export const CLIPBOARD_OWN_MS = 2_000;
// How long set-clipboard.py's background process keeps serving pasted text when no other app takes the clipboard (any
// copy on the computer, or the next paste, ends it sooner). Long enough that the text outlasts any session that pasted
// it; the cap only ends a process nobody needs. A judgment call; baked into the helper.
export const CLIPBOARD_HOLD_MS = 24 * 3600_000;

// Bounds the provider requests that shorten the timeout or pause, which callers may run while holding a lock, so a
// slow provider API cannot stall them for long. A judgment call: E2B answers these in well under a second.
export const PROVIDER_REQUEST_MS = 15_000;

// Delay between typed keystrokes (`xdotool type --delay`). Callers can estimate a `type` action's run time from it.
// A third of the E2B SDK's 75 ms default: 2000 characters type in 50 s.
export const TYPE_KEY_DELAY_MS = 25;

// How long a download link stays valid. Long enough for the user to click it after an agent shares it; short
// because anyone with the link can download the file.
export const DOWNLOAD_LINK_SECONDS = 15 * 60;

// Starting Chrome, when it is not already running. Its cold first launch took 10-28 s on E2B's lazily loaded disk;
// this leaves headroom over that.
export const ENSURE_CHROME_MS = 45_000;

// One xdotool command (a click, move, drag, or scroll). Generous: they normally take well under a second, but a
// stalled X server should fail the action, not hang the call.
export const XDOTOOL_MS = 20_000;

// Setting the system time zone: a symlink and a one-line file, which take well under a second.
export const TIME_ZONE_MS = 10_000;

// The CDP helper's own reply timeout, inside the command's. Baked into the helper (CDP_HELPER).
export const CDP_REPLY_MS = 30_000;
// The command running the CDP helper: its reply timeout plus 10 s for node start-up and the round trip.
export const CDP_COMMAND_MS = CDP_REPLY_MS + 10_000;

// Caps for each refresh step, each also clamped to what is left of the caller's budget. write: check the revision and
// write the helpers, one command. stop: Chrome's graceful exit, which takes a second or two. start: a warm relaunch,
// much faster than ENSURE_CHROME_MS's cold first launch; a slower one finishes in the next apply's own Chrome step.
// stamp: record the revision.
export const REFRESH_STEP_MS = { write: 10_000, stop: 10_000, start: 20_000, stamp: 5_000 };

// Caps for each step of a cookie apply, each also clamped to what is left of the caller's budget. chrome: start Chrome
// if needed (usually already running). prepare: create the private sync directory. upload: write the helper and the
// cookie payload. helper: run the helper, including the wait for a concurrent apply's lock. cleanup: remove the
// payload, which always runs, even after the budget.
export const SYNC_STEP_MS = { chrome: 20_000, prepare: 10_000, upload: 15_000, helper: 35_000, cleanup: 10_000 };

// Kept back from each step for the round trip and helper start-up, so the helper exits inside the budget by the
// sandbox's clock as well as ours.
export const SYNC_MARGIN_MS = 3_000;

// The least time the helper needs to clear and set cookies; with less left, the apply gives up before starting rather
// than signing the synced sites out.
export const SYNC_HELPER_MIN_MS = 5_000;

// The helper's wait for Chrome's DevTools endpoint before it gives up. Chrome is already running by then.
export const SYNC_CDP_CONNECT_MS = 5_000;

// Payload files older than this were left by an apply killed before its clean-up; the next apply deletes them.
// Comfortably longer than any apply.
export const SYNC_PAYLOAD_STALE_MINUTES = 2;
