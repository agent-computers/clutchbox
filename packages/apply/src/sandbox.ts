import { type Capture, type CapturedCookie, siteOfCookie } from '@clutchbox/capture';
import { cookieChanges, expiredCdpCookie, toCdpCookie } from './cookies';

// Applying a capture to Chrome inside a sandbox the developer runs (a runtime adapter), through the sandbox's command
// API: from outside, a sandbox's CDP port is unreachable or would have to be made public. A helper runs in the sandbox's
// own Node and drives Chrome over CDP on its loopback. The capture travels on the command's standard input, or, for a
// sandbox whose API has none, in a file in a memory-only directory that the helper deletes before it connects: never
// in a command line, which sandbox APIs log, and never on disk outside Chrome's profile.

// The apply runtime's applyCookies (chrome.ts) as plain JavaScript for a sandbox's own Node: siteOfHost must match
// @clutchbox/capture's, and toParam and partition chrome.ts's cookieParamOf and partitionCookies (sandbox.test.ts
// compares them).
export const SANDBOX_CORE = String.raw`function siteOfHost(hostname) {
  const labels = hostname.replace(/^\./, '').replace(/\.$/, '').toLowerCase().split('.');
  const secondLevel = labels.length > 2 && /^(co|com|org|net|ac|gov|edu)$/.test(labels.at(-2)) && labels.at(-1).length === 2;
  return labels.slice(secondLevel ? -3 : -2).join('.');
}
function toParam(cookie) {
  const param = { name: cookie.name, value: cookie.value, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly };
  if (cookie.domain.startsWith('.')) param.domain = cookie.domain;
  else param.url = (cookie.secure ? 'https://' : 'http://') + cookie.domain + cookie.path;
  if (cookie.sameSite) param.sameSite = cookie.sameSite;
  if (!cookie.session && cookie.expires > 0) param.expires = cookie.expires;
  if (cookie.priority) param.priority = cookie.priority;
  if (cookie.partitionKey) param.partitionKey = typeof cookie.partitionKey === 'string' ? { topLevelSite: cookie.partitionKey, hasCrossSiteAncestor: false } : cookie.partitionKey;
  return param;
}
// Setting an already-expired copy deletes the matching cookie, partition included.
const expired = cookie => ({ ...toParam(cookie), value: '', expires: 1 });
function partition(cookies, clearSites) {
  const clear = new Set(clearSites);
  return { kept: cookies.filter(cookie => !clear.has(siteOfHost(cookie.domain))).length, clear: cookies.filter(cookie => clear.has(siteOfHost(cookie.domain))) };
}
`;

// The port the sandbox's Chrome listens on for CDP, on its loopback only.
export const SANDBOX_CDP_PORT = 9222;

// `node -e` with the arguments: the CDP port, the helper's budget in milliseconds, and, without standard input, the
// payload's file. It reads { clearSites, cookies } (CDP CookieParams), deletes the file, deletes clearSites' cookies,
// sets the rest in chunks of 500 (a rejected chunk cookie by cookie), and prints only counts, or { error } with a code.
// It needs Node 22 or later, for its WebSocket.
export const SANDBOX_HELPER = `(async () => {
const fs = require('node:fs');
${SANDBOX_CORE}
const [port, budget, file] = process.argv.slice(1);
const fail = error => { console.log(JSON.stringify({ error })); process.exit(1); };
setTimeout(() => fail('timeout'), Number(budget));
if (typeof WebSocket === 'undefined') fail('node_too_old');
let input;
try {
  input = JSON.parse(fs.readFileSync(file || 0, 'utf8'));
} catch {
  fail('bad_payload');
} finally {
  if (file) try { fs.unlinkSync(file); } catch {}
}
const version = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(5000) }).then(response => response.json()).catch(() => fail('cdp_unavailable'));
const socket = new WebSocket(version.webSocketDebuggerUrl);
const pending = new Map(); let next = 0;
socket.onerror = () => fail('cdp_connection_failed');
socket.onclose = () => fail('cdp_closed');
socket.onmessage = event => { const message = JSON.parse(event.data); pending.get(message.id)?.(message); pending.delete(message.id); };
await new Promise(resolve => { socket.onopen = resolve; });
const send = (method, params) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
const call = async (method, params) => { const message = await send(method, params); if (message.error) fail('cdp_refused'); return message.result; };
const set = async cookies => {
  let ok = 0;
  for (let i = 0; i < cookies.length; i += 500) {
    const chunk = cookies.slice(i, i + 500);
    if (!(await send('Storage.setCookies', { cookies: chunk })).error) { ok += chunk.length; continue; }
    for (const cookie of chunk) if (!(await send('Storage.setCookies', { cookies: [cookie] })).error) ok++;
  }
  return ok;
};
const { kept, clear } = partition((await call('Storage.getCookies', {})).cookies, input.clearSites);
const cleared = await set(clear.map(expired));
const added = await set(input.cookies);
console.log(JSON.stringify({ kept, cleared, set: added, failed: clear.length + input.cookies.length - cleared - added }));
process.exit(0);
})();
`;

// Starts the Chrome the helper applies to, unless one already answers on the port: Google Chrome, or else Chromium,
// on the sandbox's desktop (the display given, else the first X server's, else headless), printing "started", with a
// profile of its own in ~/.config/clutchbox-chrome,
// since Chrome refuses remote debugging on its default profile. The agent then drives this Chrome. As root (some
// sandboxes run commands as root) Chrome needs --no-sandbox. Arguments: the port and the display, which may be empty.
// A Chrome it starts has lost the session cookies an earlier apply set, such as after a sandbox rebooted.
// CLUTCHBOX_CHROME names another browser binary, and CLUTCHBOX_CHROME_FLAGS adds flags.
export const START_CHROME = String.raw`port="$1"; display="$2"
up() { curl -fsS -m 2 "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 || node -e "fetch('http://127.0.0.1:$port/json/version').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; }
up && exit 0
bin="$CLUTCHBOX_CHROME"
for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
  [ -n "$bin" ] && break
  command -v "$candidate" >/dev/null 2>&1 && bin="$candidate"
done
[ -n "$bin" ] || { echo '{"error":"no_chrome"}'; exit 1; }
if [ -z "$display" ]; then x=$(ls /tmp/.X11-unix 2>/dev/null | sed -n 's/^X\([0-9][0-9]*\)$/\1/p' | head -n 1); [ -n "$x" ] && display=":$x"; fi
flags="--remote-debugging-port=$port --remote-debugging-address=127.0.0.1 --user-data-dir=$HOME/.config/clutchbox-chrome --no-first-run --no-default-browser-check"
[ "$(id -u)" = 0 ] && flags="$flags --no-sandbox"
flags="$flags $CLUTCHBOX_CHROME_FLAGS"
if [ -n "$display" ]; then DISPLAY="$display" setsid nohup "$bin" $flags about:blank >/dev/null 2>&1 &
else setsid nohup "$bin" $flags --headless=new about:blank >/dev/null 2>&1 & fi
for i in $(seq 1 100); do up && { echo started; exit 0; }; sleep 0.2; done
echo '{"error":"chrome_did_not_start"}'; exit 1
`;

// Makes `dir` a memory-only directory only its owner reads, for a sandbox whose API takes no standard input: a payload
// written there never reaches disk. A directory already in memory (in /dev/shm, or a tmpfs /tmp) is used as it is;
// otherwise a tmpfs is mounted on it, which needs root or passwordless sudo, and a mount a reboot dropped is made again.
export const PRIVATE_MEMORY_DIR = String.raw`dir="$1"
in_memory() { case "$(stat -f -c %T "$dir" 2>/dev/null)" in tmpfs|ramfs) [ "$(stat -c %u "$dir")" = "$(id -u)" ];; *) false;; esac; }
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }
mkdir -p "$dir" 2>/dev/null; chmod 700 "$dir" 2>/dev/null
in_memory && exit 0
as_root mount -t tmpfs -o "size=64m,mode=700,uid=$(id -u),gid=$(id -g)" tmpfs "$dir" >/dev/null 2>&1
in_memory || { echo '{"error":"no_private_memory"}'; exit 1; }
`;

// What a runtime adapter runs commands with, in its provider's words. `run` resolves with the exit code and standard
// output whatever the exit code, and passes `stdin` as the command's standard input. Without `stdin` support
// (maxStdinBytes 0), `writeFile` puts a payload in a file, in `privateDir`, which the adapter mounts in memory first.
export type SandboxShell = {
  run(
    command: string,
    options: { stdin?: string; timeoutMs: number },
  ): Promise<{ exitCode: number | null; stdout: string }>;
  // The most standard input one command takes, in UTF-8 bytes; larger payloads go in several runs. 0: none.
  maxStdinBytes: number;
  writeFile?(path: string, data: string): Promise<void>;
  privateDir?: string;
};

// What was last applied to a sandbox's Chrome: pass it to the next apply so only what changed is written, and Chrome
// keeps cookies it refreshed itself. Keep it private: it holds the session cookies.
export type Applied = { completedAt: string; cookies: CapturedCookie[]; sites: string[] };
export type SandboxApplyResult = { kept: number; cleared: number; set: number; failed: number; applied: Applied };

// A failure inside the sandbox, by code: no_chrome, chrome_did_not_start, node_too_old, no_private_memory,
// cdp_unavailable, cdp_connection_failed, cdp_closed, cdp_refused, bad_payload, timeout, or command_failed. Never
// carries the command's output, which could hold cookie values.
export class SandboxApplyError extends Error {
  constructor(readonly code: string) {
    super(`Applying the capture in the sandbox failed: ${code}`);
    this.name = 'SandboxApplyError';
  }
}

const b64 = (text: string) => Buffer.from(text).toString('base64');
const script = (source: string, args: string[]) =>
  `sh -c "$(echo ${b64(source)} | base64 -d)" sh ${args.map(arg => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ')}`;
const helper = (args: string[]) =>
  `node -e "$(echo ${b64(SANDBOX_HELPER)} | base64 -d)" ${args.map(arg => `'${arg}'`).join(' ')}`;
const errorOf = (stdout: string) => {
  try {
    const parsed = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { error?: unknown };
    return typeof parsed.error === 'string' && /^[a-z_]{1,40}$/.test(parsed.error) ? parsed.error : 'command_failed';
  } catch {
    return 'command_failed';
  }
};
type Counts = { kept: number; cleared: number; set: number; failed: number };
const countsOf = (stdout: string): Counts => {
  try {
    const parsed = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Partial<Counts>;
    if ([parsed.kept, parsed.cleared, parsed.set, parsed.failed].every(n => typeof n === 'number'))
      return parsed as Counts;
  } catch {}
  throw new SandboxApplyError('command_failed');
};

// Payloads of at most `max` bytes: the first carries clearSites, so later ones only set cookies.
export function payloads(clearSites: string[], cookies: unknown[], max: number) {
  const out: string[] = [];
  let batch: unknown[] = [];
  const encode = (sites: string[], list: unknown[]) => JSON.stringify({ clearSites: sites, cookies: list });
  for (const cookie of cookies) {
    const next = encode(out.length ? [] : clearSites, [...batch, cookie]);
    if (max && Buffer.byteLength(next) > max && batch.length) {
      out.push(encode(out.length ? [] : clearSites, batch));
      batch = [cookie];
    } else batch.push(cookie);
  }
  out.push(encode(out.length ? [] : clearSites, batch));
  return out;
}

// Applies a capture to the sandbox's Chrome, starting that Chrome first if it isn't running (START_CHROME). Without
// `previous`, or when Chrome had to be started, every synced site is replaced wholesale; otherwise only cookies the
// user's browser added, changed, or deleted since are written, and sites the user signed out of are cleared. Other
// sites are never touched.
export async function applyInSandbox(
  shell: SandboxShell,
  capture: Capture,
  previous?: Applied | null,
  {
    port = SANDBOX_CDP_PORT,
    display = '',
    timeoutMs = 60_000,
  }: { port?: number; display?: string; timeoutMs?: number } = {},
): Promise<SandboxApplyResult> {
  const end = Date.now() + timeoutMs;
  const left = () => {
    const ms = end - Date.now();
    if (ms < 2_000) throw new SandboxApplyError('timeout');
    return ms;
  };
  const started = await shell.run(script(START_CHROME, [String(port), display]), { timeoutMs: left() });
  if (started.exitCode !== 0) throw new SandboxApplyError(errorOf(started.stdout));
  const since = started.stdout.includes('started') ? null : previous;
  const changes = cookieChanges(since?.cookies ?? null, capture.cookies, since?.sites ?? [], capture.completedAt);
  const cookies = [...changes.set.map(toCdpCookie), ...changes.remove.map(expiredCdpCookie)];
  const total: Counts = { kept: 0, cleared: 0, set: 0, failed: 0 };
  const bodies = payloads(changes.clearSites, cookies, shell.maxStdinBytes);
  if (!shell.maxStdinBytes) {
    if (!shell.writeFile || !shell.privateDir) throw new SandboxApplyError('no_private_memory');
    const mounted = await shell.run(script(PRIVATE_MEMORY_DIR, [shell.privateDir]), { timeoutMs: left() });
    if (mounted.exitCode !== 0) throw new SandboxApplyError(errorOf(mounted.stdout));
  }
  for (const [i, body] of bodies.entries()) {
    const budget = left();
    let result: { exitCode: number | null; stdout: string };
    if (shell.maxStdinBytes)
      result = await shell.run(helper([String(port), String(budget - 1_000)]), { stdin: body, timeoutMs: budget });
    else {
      const file = `${shell.privateDir}/payload-${Date.now()}-${i}.json`;
      await shell.writeFile!(file, body);
      // The helper deletes it once read; this also covers a helper that never started.
      result = await shell.run(
        `${helper([String(port), String(budget - 1_000), file])}; status=$?; rm -f '${file}'; exit $status`,
        {
          timeoutMs: budget,
        },
      );
    }
    if (result.exitCode !== 0) throw new SandboxApplyError(errorOf(result.stdout));
    const counts = countsOf(result.stdout);
    // Cookies kept are those of the first run, before anything was set.
    if (i === 0) total.kept = counts.kept;
    total.cleared += counts.cleared;
    total.set += counts.set;
    total.failed += counts.failed;
  }
  const applied: Applied = {
    completedAt: capture.completedAt,
    cookies: capture.cookies,
    sites: [...new Set(capture.cookies.map(siteOfCookie))].sort(),
  };
  return { ...total, applied };
}
