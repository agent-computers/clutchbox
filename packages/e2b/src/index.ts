import { createHash, randomUUID } from 'node:crypto';
import { type ComputerProvider, type ComputerSession, DISPLAY, type ExecResult } from '@agent-computers/computer';
import { Sandbox } from '@e2b/desktop';
import { Sandbox as BaseSandbox, CommandExitError, TimeoutError } from 'e2b';
import {
  CDP_COMMAND_MS,
  CDP_REPLY_MS,
  CLIPBOARD_CLEANUP_MS,
  CLIPBOARD_HOLD_MS,
  CLIPBOARD_OWN_MS,
  DOWNLOAD_LINK_SECONDS,
  ENSURE_CHROME_MS,
  PROVIDER_REQUEST_MS,
  REFRESH_STEP_MS,
  STREAM_MARGIN_MS,
  STREAM_START_MS,
  SYNC_CDP_CONNECT_MS,
  SYNC_HELPER_MIN_MS,
  SYNC_MARGIN_MS,
  SYNC_PAYLOAD_STALE_MINUTES,
  SYNC_STEP_MS,
  TIME_ZONE_MS,
  TYPE_KEY_DELAY_MS,
  XDOTOOL_MS,
} from './timing';

// Agent computers on E2B: a desktop sandbox from a template with Chrome running, controlled with xdotool, CDP, and
// commands. Helpers are baked into the template (TEMPLATE, built with HELPERS and START_DESKTOP) and kept current on
// older computers by refresh.
export const HELPER_DIR = '/opt/agent-computers';
export const TEMPLATE = 'agent-computers-desktop';
const OUTPUT_LIMIT = 32_000;
const clip = (text: string) => (text.length > OUTPUT_LIMIT ? text.slice(0, OUTPUT_LIMIT) : text);
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
// A tab showing nothing yet: Chrome's start page or a new tab.
const isBlank = (url: string) => url === 'about:blank' || /^chrome:\/\/(newtab|new-tab-page)\//.test(url);

// Sandboxed Chrome (no --no-sandbox). With no GPU, --ignore-gpu-blocklist gives WebGL through Mesa's llvmpipe
// (maps, charts, and bot checks that expect it), and --disable-gpu-compositing keeps ordinary pages on the faster
// software compositor (scrolling at 55-60 fps instead of 40-51 on 2 vCPUs). No TZ: Chrome follows the system zone
// (setTimeZone).
export const ENSURE_CHROME = `#!/bin/sh
curl -sf http://127.0.0.1:9222/json/version >/dev/null && exit 0
DISPLAY=:0 nohup google-chrome --user-data-dir=/home/user/.config/agent-computers-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --no-first-run --no-default-browser-check --disable-sync --ignore-gpu-blocklist --disable-gpu-compositing --start-maximized about:blank >/tmp/agent-computers-chrome.log 2>&1 &
for i in $(seq 1 60); do curl -sf http://127.0.0.1:9222/json/version >/dev/null && exit 0; sleep 0.5; done
exit 1
`;
// The template's start command: E2B snapshots the desktop with Chrome already running, so a new
// computer skips Chrome's cold first launch (~10-28s on a lazily loaded disk). Mirrors @e2b/desktop's
// own Xvfb and XFCE start, which create therefore skips.
export const START_DESKTOP = `#!/bin/sh
Xvfb :0 -ac -screen 0 ${DISPLAY.width}x${DISPLAY.height}x24 -retro -dpi 96 -nolisten tcp -nolisten unix >/tmp/xvfb.log 2>&1 &
for i in $(seq 1 40); do xdpyinfo -display :0 >/dev/null 2>&1 && break; sleep 0.25; done
DISPLAY=:0 startxfce4 >/tmp/xfce.log 2>&1 &
for i in $(seq 1 120); do pgrep -x xfce4-session >/dev/null && pgrep -x xfwm4 >/dev/null && pgrep -x xfdesktop >/dev/null && break; sleep 0.5; done
${HELPER_DIR}/ensure-chrome.sh
wait
`;
// Request/response CDP only: one command per process, events are not buffered.
export const CDP_HELPER = `const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString());
const done = value => { console.log(JSON.stringify(value)); process.exit(0); };
setTimeout(() => done({ error: 'cdp_timeout' }), ${CDP_REPLY_MS});
const url = input.targetId ? 'ws://127.0.0.1:9222/devtools/page/' + input.targetId : (await fetch('http://127.0.0.1:9222/json/version').then(response => response.json()).catch(() => done({ error: 'cdp_unavailable' }))).webSocketDebuggerUrl;
const socket = new WebSocket(url);
socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: input.method, params: input.params ?? {} }));
socket.onmessage = event => { const message = JSON.parse(event.data); if (message.id === 1) done(message.error ? { error: message.error } : { result: message.result }); };
socket.onerror = () => done({ error: 'cdp_connection_failed' });
`;

// Cookie sync runs inside the sandbox in one process, as plain JavaScript: SYNC_CORE and SYNC_HELPER are the open apply
// runtime's applyCookies (packages/apply/src/chrome.ts) for a computer's own Node. siteOfHost must match
// packages/capture/src/sync.ts, and toParam and partition the apply runtime (index.test.ts compares them).
export const SYNC_CORE = String.raw`function siteOfHost(hostname) {
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
// Prints only counts. Deletes only clearSites' cookies, then sets the incoming ones: other
// sites are never touched, so a run cut short only affects sites the next open rewrites.
// Sets in chunks; a rejected chunk is retried cookie by cookie.
// argv[3] is the helper's share of the caller's budget: it exits by then, cut short or not.
export const SYNC_HELPER = `import { readFileSync } from 'node:fs';
${SYNC_CORE}
const fail = error => { console.log(JSON.stringify({ error })); process.exit(1); };
setTimeout(() => fail('sync_timeout'), Number(process.argv[3]));
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const version = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(${SYNC_CDP_CONNECT_MS}) }).then(response => response.json()).catch(() => fail('cdp_unavailable'));
const socket = new WebSocket(version.webSocketDebuggerUrl);
const pending = new Map(); let next = 0;
socket.onerror = () => fail('cdp_connection_failed');
socket.onclose = () => fail('cdp_closed');
socket.onmessage = event => { const message = JSON.parse(event.data); pending.get(message.id)?.(message); pending.delete(message.id); };
await new Promise(resolve => { socket.onopen = resolve; });
const send = (method, params) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
const call = async (method, params) => { const message = await send(method, params); if (message.error) fail(method + ' failed'); return message.result; };
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
`;
// Live view's stream, started on demand and left running: x11vnc on the display with input, listening only
// on a Unix socket (-rfbportv6 -1 too, or it still opens IPv6 port 5900), and websockify on STREAM_PORT, the one
// port the relay reaches, with the provider's traffic token. Both come with E2B's desktop template. Idempotent and
// serialized (flock), so concurrent relays start one of each; exits 0 once the socket and the port are up.
// Probed on the template: x11vnc 0.9.16, and websockify 0.12.0 vendored with noVNC in /opt/noVNC.
// -noprimary: x11vnc sends viewers only CLIPBOARD, not PRIMARY, so merely selecting text on the computer does not
// overwrite the user's own clipboard. An x11vnc started before the flag is replaced once it has exited, so one serves
// the display (vnc lists the running ones; a zombie's cmdline is empty). Pasting goes through SET_CLIPBOARD instead.
export const STREAM_PORT = 6080;
const STREAM_DIR = '/tmp/live-view';
// The traffic token guards the port only from outside: inside, any page the computer's Chrome visits can open a
// WebSocket to 127.0.0.1:6080. So websockify upgrades only a handshake whose Origin is this, which the relay sends
// and no web page can (a browser always sends the page's own origin, a scheme and host, or "null"). Not a secret:
// processes on the computer can reach the VNC socket anyway, and they already have the desktop.
export const STREAM_ORIGIN = 'agent-computers-relay';
export const LIVE_VIEW_STREAM = `#!/bin/sh
D=${STREAM_DIR}
end=$(($(date +%s) + ${STREAM_START_MS / 1000}))
mkdir -p $D && exec 9>$D/lock && flock -w ${STREAM_START_MS / 1000} 9 || exit 1
listening() { ss -Hltn "sport = :${STREAM_PORT}" | grep -q .; }
vnc() { for p in $(pgrep -u "$(id -u)" -x x11vnc); do a=$(tr '\\0' ' ' </proc/$p/cmdline 2>/dev/null) && [ -n "$a" ] && echo "$p $a"; done; }
old=$(vnc | grep -v -- ' -noprimary ' | cut -d' ' -f1)
if [ -n "$old" ]; then
  kill $old
  while vnc | grep -qv -- ' -noprimary ' && [ "$(date +%s)" -le "$end" ]; do sleep 0.1; done
fi
if ! vnc | grep -q -- ' -noprimary '; then
  rm -f $D/vnc.sock
  (setsid nohup x11vnc -display :0 -rfbport 0 -rfbportv6 -1 -unixsock $D/vnc.sock -noprimary -forever -shared -nopw -quiet >$D/x11vnc.log 2>&1 </dev/null 9>&- &)
fi
listening || (cd /opt/noVNC/utils/websockify && setsid nohup ./run --auth-plugin ExpectOrigin --auth-source ${STREAM_ORIGIN} --unix-target=$D/vnc.sock 0.0.0.0:${STREAM_PORT} >$D/websockify.log 2>&1 </dev/null 9>&- &)
while [ "$(date +%s)" -le "$end" ]; do [ -S $D/vnc.sock ] && listening && exit 0; sleep 0.25; done
exit 1
`;
// Live view's paste, through libX11 with ctypes, since the template has no xclip or xsel.
// x11vnc's own paste (RFB cut text) takes the clipboard only once, so Chrome keeps pasting the first text, and carries
// Latin-1 only. Run as `user` with DISPLAY=:0.
export const SET_CLIPBOARD = `# Live view's paste: sets the X CLIPBOARD (not PRIMARY) to the UTF-8 text in argv[1], which it deletes, and serves it from
# a background process until another app takes the clipboard or HOLD_SECONDS pass. Exits 0 once it owns the
# clipboard, 2 when the text is too large for one X request, 1 otherwise. Run as the desktop's user with DISPLAY set.
import ctypes, fcntl, os, select, signal, sys, time

OWN_SECONDS = ${CLIPBOARD_OWN_MS / 1000}
HOLD_SECONDS = ${CLIPBOARD_HOLD_MS / 1000}
PIDFILE = '${STREAM_DIR}/clipboard.pid'
LOCK = '${STREAM_DIR}/clipboard.lock'
# The most a STRING reply carries. x11vnc 0.9.16 reads one in 64 KiB chunks but rereads the second chunk past 128 KiB
# (selection.c), then sends viewers 256 KiB of garbled text, which the page writes over the user's own clipboard.
# Larger text is refused as STRING; Chrome pastes UTF8_STRING.
STRING_MAX = 131072
os.makedirs(os.path.dirname(PIDFILE), exist_ok=True)

path = sys.argv[1]
try:
    with open(path, 'rb') as file:
        data = file.read().decode('utf-8', 'replace').encode('utf-8')
finally:
    try:
        os.unlink(path)
    except OSError:
        pass

C = ctypes
X = C.CDLL('libX11.so.6')
for name, res, args in [
    ('XOpenDisplay', C.c_void_p, [C.c_char_p]),
    ('XInternAtom', C.c_ulong, [C.c_void_p, C.c_char_p, C.c_int]),
    ('XDefaultRootWindow', C.c_ulong, [C.c_void_p]),
    ('XCreateSimpleWindow', C.c_ulong, [C.c_void_p, C.c_ulong, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_uint, C.c_ulong, C.c_ulong]),
    ('XSetSelectionOwner', C.c_int, [C.c_void_p, C.c_ulong, C.c_ulong, C.c_ulong]),
    ('XGetSelectionOwner', C.c_ulong, [C.c_void_p, C.c_ulong]),
    ('XChangeProperty', C.c_int, [C.c_void_p, C.c_ulong, C.c_ulong, C.c_ulong, C.c_int, C.c_int, C.c_void_p, C.c_int]),
    ('XSendEvent', C.c_int, [C.c_void_p, C.c_ulong, C.c_int, C.c_long, C.c_void_p]),
    ('XNextEvent', C.c_int, [C.c_void_p, C.c_void_p]),
    ('XPending', C.c_int, [C.c_void_p]),
    ('XFlush', C.c_int, [C.c_void_p]),
    ('XConnectionNumber', C.c_int, [C.c_void_p]),
    ('XExtendedMaxRequestSize', C.c_long, [C.c_void_p]),
    ('XMaxRequestSize', C.c_long, [C.c_void_p]),
    ('XSetErrorHandler', C.c_void_p, [C.c_void_p]),
]:
    getattr(X, name).restype = res
    getattr(X, name).argtypes = args

class SelectionRequest(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send_event', C.c_int), ('display', C.c_void_p), ('owner', C.c_ulong), ('requestor', C.c_ulong), ('selection', C.c_ulong), ('target', C.c_ulong), ('property', C.c_ulong), ('time', C.c_ulong)]
class Selection(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send_event', C.c_int), ('display', C.c_void_p), ('requestor', C.c_ulong), ('selection', C.c_ulong), ('target', C.c_ulong), ('property', C.c_ulong), ('time', C.c_ulong)]
class SelectionClear(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send_event', C.c_int), ('display', C.c_void_p), ('window', C.c_ulong), ('selection', C.c_ulong), ('time', C.c_ulong)]
class Event(C.Union):
    _fields_ = [('type', C.c_int), ('request', SelectionRequest), ('selection', Selection), ('clear', SelectionClear), ('pad', C.c_long * 24)]
SELECTION_CLEAR, SELECTION_REQUEST, SELECTION_NOTIFY, XA_ATOM = 29, 30, 31, 4

# The parent waits for the background process to own the clipboard, or to give up, and exits with its answer.
deadline = time.monotonic() + OWN_SECONDS
reader, writer = os.pipe()
if os.fork():
    os.close(writer)
    ready, _, _ = select.select([reader], [], [], OWN_SECONDS)
    answer = os.read(reader, 1) if ready else b''
    sys.exit(int(answer) if answer in (b'0', b'2') else 1)
os.close(reader)
os.setsid()
null = os.open(os.devnull, os.O_RDWR)
for fd in (0, 1, 2):
    os.dup2(null, fd)
def answer(code):
    os.write(writer, code)
    sys.exit(0)

def started(pid):
    with open('/proc/%d/stat' % pid) as stat:
        return stat.read().rsplit(')', 1)[1].split()[19]

display = X.XOpenDisplay(None)
if not display:
    answer(b'1')
# A requestor that vanishes mid-reply raises an X error; the default handler would exit.
ignore = C.CFUNCTYPE(C.c_int, C.c_void_p, C.c_void_p)(lambda *_: 0)
X.XSetErrorHandler(ignore)
# One ChangeProperty request carries the whole text, with room for its header.
if len(data) > (X.XExtendedMaxRequestSize(display) or X.XMaxRequestSize(display)) * 4 - 64:
    answer(b'2')
atom = lambda name: X.XInternAtom(display, name.encode(), 0)
CLIPBOARD, TARGETS, UTF8, STRING, TEXT, PLAIN = (atom(name) for name in ('CLIPBOARD', 'TARGETS', 'UTF8_STRING', 'STRING', 'TEXT', 'text/plain;charset=utf-8'))
served = [TARGETS, UTF8, TEXT, PLAIN] + ([STRING] if len(data) <= STRING_MAX else [])
targets = (C.c_ulong * len(served))(*served)
text = C.create_string_buffer(data, len(data) + 1)
window = X.XCreateSimpleWindow(display, X.XDefaultRootWindow(display), 0, 0, 1, 1, 0, 0, 0)
# Overlapping runs take the clipboard one at a time, so another run can't take it between this one's take and check.
lock = os.open(LOCK, os.O_WRONLY | os.O_CREAT, 0o600)
while True:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() > deadline:
            answer(b'1')
        time.sleep(0.01)
X.XSetSelectionOwner(display, CLIPBOARD, window, 0)
if X.XGetSelectionOwner(display, CLIPBOARD) != window:
    answer(b'1')
# One owner at a time: taking the clipboard already ended an earlier run (SelectionClear), so it is gone or going; one
# that is wedged ends here, if the pidfile still names it. Ending it only now leaves no moment without an owner.
try:
    pid, start = open(PIDFILE).read().split()
    if int(pid) != os.getpid() and started(int(pid)) == start:
        os.kill(int(pid), signal.SIGTERM)
except (OSError, ValueError):
    pass
with open(PIDFILE + '.new', 'w') as file:
    file.write('%d %s' % (os.getpid(), started(os.getpid())))
os.replace(PIDFILE + '.new', PIDFILE)
os.close(lock)
os.write(writer, b'0')
os.close(writer)

def reply(request):
    prop = request.property or request.target
    if request.target == TARGETS:
        X.XChangeProperty(display, request.requestor, prop, XA_ATOM, 32, 0, targets, len(targets))
    elif request.target in served and request.target != TARGETS:
        # STRING gets UTF-8 too, as Chrome answers it: x11vnc reads STRING and passes the bytes to the page, which
        # decodes them as UTF-8.
        kind = UTF8 if request.target == TEXT else request.target
        X.XChangeProperty(display, request.requestor, prop, kind, 8, 0, text, len(data))
    else:
        prop = 0
    event = Event()
    event.selection = Selection(SELECTION_NOTIFY, 0, 1, display, request.requestor, request.selection, request.target, prop, request.time)
    X.XSendEvent(display, request.requestor, 0, 0, C.byref(event))

event = Event()
end = time.monotonic() + HOLD_SECONDS
while time.monotonic() < end:
    while X.XPending(display):
        X.XNextEvent(display, C.byref(event))
        if event.type == SELECTION_CLEAR and event.clear.selection == CLIPBOARD:
            sys.exit(0)
        if event.type == SELECTION_REQUEST:
            reply(event.request)
    X.XFlush(display)
    select.select([X.XConnectionNumber(display)], [], [], max(0, end - time.monotonic()))
`;
// Every helper in HELPER_DIR. The template build writes them, and refresh rewrites them on computers made from
// an older template, which keep running it until reset.
export const HELPERS = [
  { name: 'ensure-chrome.sh', content: ENSURE_CHROME, mode: '755' },
  { name: 'cdp.mjs', content: CDP_HELPER, mode: '644' },
  { name: 'start-desktop.sh', content: START_DESKTOP, mode: '755' },
  { name: 'live-view-stream.sh', content: LIVE_VIEW_STREAM, mode: '755' },
  { name: 'set-clipboard.py', content: SET_CLIPBOARD, mode: '644' },
] as const;
// Changes with any helper, Chrome's flags included. A computer records the revision it runs in REVISION_FILE.
export const REVISION = createHash('sha256').update(JSON.stringify(HELPERS)).digest('hex').slice(0, 12);
export const REVISION_FILE = `${HELPER_DIR}/revision`;
// A shell command that writes the helpers in place, each replaced whole (rename), never half written.
export const writeHelpers = () =>
  HELPERS.map(
    ({ name, content, mode }) =>
      `echo ${Buffer.from(content).toString('base64')} | base64 -d > ${HELPER_DIR}/${name}.new && chmod ${mode} ${HELPER_DIR}/${name}.new && mv -f ${HELPER_DIR}/${name}.new ${HELPER_DIR}/${name}`,
  ).join(' && ');
const SYNC_DIR = '/home/user/.agent-computers';

function session(sandbox: Sandbox): ComputerSession {
  const xdotool = async (args: string) => {
    await sandbox.commands.run(`xdotool ${args}`, { envs: { DISPLAY: ':0' }, timeoutMs: XDOTOOL_MS });
  };
  const ensureChrome = (timeoutMs = ENSURE_CHROME_MS) =>
    sandbox.commands.run(`${HELPER_DIR}/ensure-chrome.sh`, { timeoutMs });
  const cdp: ComputerSession['cdp'] = async input => {
    const payload = Buffer.from(JSON.stringify(input)).toString('base64');
    // Computers built from an older template exit non-zero when Chrome is down (kept until the user resets it).
    try {
      return (
        await sandbox.commands.run(`node ${HELPER_DIR}/cdp.mjs ${payload}`, { timeoutMs: CDP_COMMAND_MS })
      ).stdout.trim();
    } catch (error) {
      if (error instanceof CommandExitError) return JSON.stringify({ error: 'cdp_unavailable' });
      throw error;
    }
  };
  // Open tabs; none when Chrome is down or does not answer.
  const tabs = async () => {
    const reply = JSON.parse(await cdp({ method: 'Target.getTargets' }));
    const targets: { targetId: string; type: string; url: string }[] = reply.result?.targetInfos ?? [];
    return targets.filter(target => target.type === 'page');
  };
  return {
    isPrivate: !!sandbox.trafficAccessToken,
    screenshot: () => sandbox.screenshot(),
    // Direct xdotool, one command per action: the SDK's `mousemove --sync` can stall ~15s.
    async act(action) {
      const button = { left: 1, middle: 2, right: 3 } as const;
      switch (action.type) {
        case 'click':
          return xdotool(
            `mousemove ${action.x} ${action.y} click ${action.double ? '--repeat 2 ' : ''}${button[action.button]}`,
          );
        case 'move':
          return xdotool(`mousemove ${action.x} ${action.y}`);
        case 'drag':
          return xdotool(
            `mousemove ${action.from[0]} ${action.from[1]} mousedown 1 sleep 0.1 mousemove ${action.to[0]} ${action.to[1]} sleep 0.1 mouseup 1`,
          );
        case 'scroll':
          return xdotool(
            `${action.x !== undefined && action.y !== undefined ? `mousemove ${action.x} ${action.y} ` : ''}click --repeat ${action.amount} ${action.direction === 'up' ? 4 : 5}`,
          );
        case 'type':
          return sandbox.write(action.text, { chunkSize: 50, delayInMs: TYPE_KEY_DELAY_MS });
        case 'key':
          return sandbox.press(action.keys);
        case 'wait':
          return sandbox.wait(action.ms);
      }
    },
    cdp,
    async exec({ command, cwd, timeoutSeconds }): Promise<ExecResult> {
      const result = (exitCode: number | null, stdout: string, stderr: string, timedOut = false) => ({
        exitCode,
        stdout: clip(stdout),
        stderr: clip(stderr),
        truncated: stdout.length > OUTPUT_LIMIT || stderr.length > OUTPUT_LIMIT,
        timedOut,
      });
      try {
        // envd rejects a missing cwd as an SDK error; cd makes it an ordinary exit 1 with stderr.
        const run = await sandbox.commands.run(cwd ? `cd -- ${quote(cwd)} || exit 1\n${command}` : command, {
          user: 'user',
          timeoutMs: timeoutSeconds * 1000,
        });
        return result(run.exitCode, run.stdout, run.stderr);
      } catch (error) {
        if (error instanceof CommandExitError) return result(error.exitCode, error.stdout, error.stderr);
        if (error instanceof TimeoutError) return result(null, '', '', true);
        throw error;
      }
    },
    // Keeps or opens one blank tab first, since Chrome quits with its last tab. Target.closeTarget skips
    // beforeunload prompts, which would otherwise block. Never starts Chrome.
    async closeTabs() {
      const open = await tabs();
      if (open.length <= 1 && open.every(tab => isBlank(tab.url))) return;
      let keep = open.find(tab => isBlank(tab.url))?.targetId;
      if (!keep) {
        const created = JSON.parse(await cdp({ method: 'Target.createTarget', params: { url: 'about:blank' } }));
        keep = created.result?.targetId;
        if (!keep) throw new Error('no blank tab');
      }
      await Promise.all(
        open
          .filter(tab => tab.targetId !== keep)
          .map(tab => cdp({ method: 'Target.closeTarget', params: { targetId: tab.targetId } })),
      );
    },
    downloadUrl: path => sandbox.downloadUrl(path, { user: 'user', useSignatureExpiration: DOWNLOAD_LINK_SECONDS }),
    // Unlike connect, which only ever extends it, this also shortens the timeout. Bounded: the caller
    // may hold a lock across it.
    setTimeout: timeoutMs => sandbox.setTimeout(timeoutMs, { requestTimeoutMs: PROVIDER_REQUEST_MS }),
    // Brings a computer made from an older template to REVISION: rewrites the helpers as root, then restarts
    // Chrome on them. SIGTERM is Chrome's graceful exit, so cookies and the profile reach disk and sign-ins
    // stay; open tabs close. A Chrome that does not exit in time is killed. A computer already on REVISION
    // (a new one from a current template) costs one command. Every step is clamped to budgetMs.
    async refresh(budgetMs) {
      const end = Date.now() + budgetMs;
      const left = (cap: number) => {
        const ms = Math.min(cap, end - Date.now());
        if (ms < SYNC_MARGIN_MS) throw new Error('refresh budget exceeded');
        return ms;
      };
      const { stdout } = await sandbox.commands.run(
        `test "$(cat ${REVISION_FILE} 2>/dev/null)" = ${REVISION} && echo current && exit 0; mkdir -p ${HELPER_DIR} && ${writeHelpers()} && echo stale`,
        { user: 'root', timeoutMs: left(REFRESH_STEP_MS.write) },
      );
      if (stdout.trim() === 'current') return 'current';
      // The browser process is the oldest `chrome`; its renderers and zygotes exit with it.
      const stopMs = left(REFRESH_STEP_MS.stop);
      const polls = Math.max(1, Math.floor((stopMs - SYNC_MARGIN_MS) / 500));
      await sandbox.commands.run(
        `pkill -TERM -o -x chrome || exit 0; for i in $(seq 1 ${polls}); do pgrep -x chrome >/dev/null || exit 0; sleep 0.5; done; pkill -KILL -x chrome; sleep 0.5`,
        { user: 'user', timeoutMs: stopMs },
      );
      await ensureChrome(left(REFRESH_STEP_MS.start));
      await sandbox.commands.run(`echo ${REVISION} > ${REVISION_FILE}`, {
        user: 'root',
        timeoutMs: left(REFRESH_STEP_MS.stamp),
      });
      return 'refreshed';
    },
    // As root: /etc/localtime is the system zone, and Chrome (started without TZ) follows a change to it in
    // open tabs too. A zone tzdata lacks fails the command and leaves the old one.
    async setTimeZone(timeZone) {
      const zone = quote(`/usr/share/zoneinfo/${timeZone}`);
      await sandbox.commands.run(
        `test -f ${zone} && ln -sf ${zone} /etc/localtime && echo ${quote(timeZone)} > /etc/timezone`,
        { user: 'root', timeoutMs: TIME_ZONE_MS },
      );
    },
    // The payload holds session cookies: written to a private file (never argv) and always removed.
    // Every step is clamped to budgetMs and the helper exits on its own inside it, so nothing in
    // the computer changes cookies after the caller gives up: sync never lands during a task.
    // flock serializes overlapping applies (an open and a close racing on one computer).
    async syncCookies({ clearSites, cookies, budgetMs }) {
      const helper = `${SYNC_DIR}/sync-cookies.mjs`;
      const payload = `${SYNC_DIR}/sync-${randomUUID()}.json`;
      const end = Date.now() + budgetMs;
      const left = (cap: number) => {
        const ms = Math.min(cap, end - Date.now());
        if (ms < SYNC_MARGIN_MS) throw new Error('sync budget exceeded');
        return ms;
      };
      try {
        await ensureChrome(left(SYNC_STEP_MS.chrome));
        // Also removes payloads left by a run that was killed before its cleanup.
        await sandbox.commands.run(
          `umask 077 && mkdir -p ${SYNC_DIR} && chmod 700 ${SYNC_DIR} && find ${SYNC_DIR} -maxdepth 1 -name 'sync-*.json' -mmin +${SYNC_PAYLOAD_STALE_MINUTES} -delete && : > ${payload} && chmod 600 ${payload}`,
          { user: 'user', timeoutMs: left(SYNC_STEP_MS.prepare) },
        );
        await sandbox.files.write(
          [
            { path: helper, data: SYNC_HELPER },
            { path: payload, data: JSON.stringify({ clearSites, cookies }) },
          ],
          { user: 'user', requestTimeoutMs: left(SYNC_STEP_MS.upload) },
        );
        // Lock wait plus the helper's own exit timer stay a margin inside what is left.
        const timeoutMs = left(SYNC_STEP_MS.helper);
        const inside = timeoutMs - SYNC_MARGIN_MS;
        // Too little time to clear and re-set cookies: starting would sign the synced sites out.
        if (inside < SYNC_HELPER_MIN_MS) throw new Error('sync budget exceeded');
        const waitSeconds = Math.min(10, Math.floor(inside / 3000));
        const node = `node ${helper} ${payload} ${inside - waitSeconds * 1000}`;
        const { stdout } = await sandbox.commands.run(
          `umask 077 && chmod 600 ${helper} ${payload} && if command -v flock >/dev/null; then flock -w ${waitSeconds} ${SYNC_DIR}/sync.lock ${node}; else ${node}; fi`,
          { user: 'user', timeoutMs },
        );
        const counts = JSON.parse(stdout.trim()) as { kept: number; cleared: number; set: number };
        return { kept: counts.kept, cleared: counts.cleared, set: counts.set };
      } catch {
        // Command errors can echo helper output; never let it reach logs.
        throw new Error('cookie sync failed');
      } finally {
        await sandbox.files.remove(payload, { user: 'user', requestTimeoutMs: SYNC_STEP_MS.cleanup }).catch(() => {});
      }
    },
    // A computer without a traffic token accepts public traffic: starting the stream there would put its desktop,
    // with input, on a public URL. A computer not yet refreshed to a revision with the helper runs it inline.
    async stream(budgetMs) {
      const token = sandbox.trafficAccessToken;
      if (!token) throw new Error('computer accepts public traffic');
      const helper = `${HELPER_DIR}/live-view-stream.sh`;
      const inline = `echo ${Buffer.from(LIVE_VIEW_STREAM).toString('base64')} | base64 -d | sh`;
      await sandbox.commands.run(`if [ -x ${helper} ]; then ${helper}; else ${inline}; fi`, {
        user: 'user',
        timeoutMs: Math.min(budgetMs, STREAM_START_MS + STREAM_MARGIN_MS),
      });
      return {
        url: `wss://${sandbox.getHost(STREAM_PORT)}/`,
        headers: { 'e2b-traffic-access-token': token, origin: STREAM_ORIGIN },
      };
    },
    // The text goes in a file, never argv, which the helper deletes once read; a failed run removes it here. A computer
    // not yet refreshed to a revision with the helper runs it inline. Errors never carry the text. The write and the
    // run leave the removal its share of the budget, so a stalled computer fails within it.
    async setClipboard(text, budgetMs) {
      const cleanupMs = Math.min(CLIPBOARD_CLEANUP_MS, budgetMs / 2);
      const end = Date.now() + budgetMs - cleanupMs;
      const left = () => {
        const ms = end - Date.now();
        if (ms <= 0) throw new Error('clipboard budget exceeded');
        return ms;
      };
      const file = `${STREAM_DIR}/clipboard-${randomUUID()}`;
      const helper = `${HELPER_DIR}/set-clipboard.py`;
      const inline = `python3 -c "$(echo ${Buffer.from(SET_CLIPBOARD).toString('base64')} | base64 -d)"`;
      try {
        await sandbox.files.write(file, text, { user: 'user', requestTimeoutMs: left() });
        await sandbox.commands.run(`if [ -f ${helper} ]; then python3 ${helper} ${file}; else ${inline} ${file}; fi`, {
          user: 'user',
          envs: { DISPLAY: ':0' },
          timeoutMs: left(),
        });
      } catch (error) {
        await sandbox.files.remove(file, { user: 'user', requestTimeoutMs: cleanupMs }).catch(() => {});
        if (error instanceof CommandExitError) throw new Error(`set-clipboard exited ${error.exitCode}`);
        throw error;
      }
    },
  };
}

export function e2bComputerProvider(template = process.env.E2B_COMPUTER_TEMPLATE || TEMPLATE): ComputerProvider {
  return {
    revision: REVISION,
    async find(computerId) {
      const [found] = await Sandbox.list({ query: { metadata: { computerId } } }).nextItems();
      return found?.sandboxId ?? null;
    },
    // E2B pauses (memory included) when timeoutMs lapses without another connect.
    async create(computerId, timeoutMs) {
      // The template's snapshot already runs the desktop and Chrome (START_DESKTOP).
      // Private: every port needs the traffic token, which stays on the caller's server.
      const sandbox = await BaseSandbox.create(template, {
        envs: { DISPLAY: ':0' },
        network: { allowPublicTraffic: false },
        timeoutMs,
        lifecycle: { onTimeout: 'pause', autoResume: false },
        metadata: { computerId, app: 'agent-computers' },
      });
      try {
        await sandbox.commands.run(`${HELPER_DIR}/ensure-chrome.sh`, { timeoutMs: ENSURE_CHROME_MS });
      } catch (error) {
        await sandbox.pause().catch(() => {});
        throw error;
      }
      return sandbox.sandboxId;
    },
    async connect(sandboxId, timeoutMs) {
      // Connecting resumes a paused computer; on a running one it only extends the timeout.
      return session(await Sandbox.connect(sandboxId, { timeoutMs }));
    },
    async pause(sandboxId) {
      // Memory and filesystem; false (already paused) is fine. Bounded like setTimeout.
      await BaseSandbox.pause(sandboxId, { requestTimeoutMs: PROVIDER_REQUEST_MS });
    },
    async setTimeout(sandboxId, timeoutMs) {
      await BaseSandbox.setTimeout(sandboxId, timeoutMs, { requestTimeoutMs: PROVIDER_REQUEST_MS });
    },
    async kill(sandboxId) {
      await Sandbox.kill(sandboxId);
    },
  };
}
