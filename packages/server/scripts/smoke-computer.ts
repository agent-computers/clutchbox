// Live check of the E2B provider against a disposable computer; always kills it. Its live view checks need the helpers
// of this checkout: a template built from them (CI), or SMOKE_REFRESH=1, which refreshes the computer first.
// Usage: bun run computer:smoke [output-dir]   (requires E2B_API_KEY or the E2B CLI login)
// SMOKE_SYNC=1 also checks cookie sync with synthetic cookies only. SMOKE_REFRESH=1 also checks that a computer
// made stale like an old one (old Chrome flags, no revision) is refreshed and keeps its cookies.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { toCdpCookie } from '@agent-computers/apply';
import { e2bComputerProvider, HELPER_DIR, REVISION, REVISION_FILE } from '@agent-computers/e2b';
import { WebSocket } from 'ws';
import { bundle, cookie } from '../src/capture-fixtures';
import { CALL_HOLD_MS, CLIPBOARD_SET_MS, REFRESH_BUDGET_MS, SYNC_BUDGET_MS } from '../src/computer-timing';

if (!process.env.E2B_API_KEY) {
  const cli = JSON.parse(await readFile(join(homedir(), '.e2b', 'config.json'), 'utf8').catch(() => '{}'));
  if (cli.projectApiKey) process.env.E2B_API_KEY = cli.projectApiKey;
}
const out = process.argv[2] ?? 'results';
await mkdir(out, { recursive: true });
const provider = e2bComputerProvider();
const timings: Record<string, number> = {};
const timed = async <T>(name: string, work: () => Promise<T>) => {
  const start = Date.now();
  try {
    return await work();
  } finally {
    timings[name] = Date.now() - start;
  }
};
const checks: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const computerId = randomUUID();
const forkComputerId = randomUUID();
let sandboxId: string | undefined;
let forkId: string | undefined;
let snapshotId: string | undefined;
try {
  sandboxId = await timed('create', () => provider.create(computerId, CALL_HOLD_MS));
  checks.findByMetadata = (await provider.find(computerId)) === sandboxId;
  let session = await timed('connect', () => provider.connect(sandboxId!, CALL_HOLD_MS));
  const tabUrls = async () =>
    (
      (JSON.parse(await session.cdp({ method: 'Target.getTargets' })).result?.targetInfos ?? []) as {
        type: string;
        url: string;
      }[]
    )
      .filter(target => target.type === 'page')
      .map(target => target.url);
  await timed('open tab', () => session.cdp({ method: 'Target.createTarget', params: { url: 'https://example.com' } }));
  await new Promise(resolve => setTimeout(resolve, 2000));
  const targets = JSON.parse(await timed('cdp', () => session.cdp({ method: 'Target.getTargets' })));
  const page = targets.result?.targetInfos?.find(
    (target: { url: string; type: string }) => target.type === 'page' && target.url.includes('example.com'),
  );
  checks.cdpPage = !!page;
  const title = JSON.parse(
    await session.cdp({
      method: 'Runtime.evaluate',
      params: { expression: 'document.title', returnByValue: true },
      targetId: page?.targetId,
    }),
  );
  checks.cdpTitle = title.result?.result?.value;
  if (process.env.SMOKE_SYNC === '1') {
    // Synthetic only: example.org stands in for a site only ever used on the computer,
    // example.com for a synced site with one stale cookie the sync must replace.
    await session.cdp({
      method: 'Storage.setCookies',
      params: {
        cookies: [
          {
            name: 'computer_sid',
            value: 'computer',
            url: 'https://example.org/',
            path: '/',
            secure: true,
            httpOnly: true,
          },
          { name: 'stale', value: 'old', url: 'https://example.com/', path: '/', secure: true, httpOnly: false },
        ],
      },
    });
    const synthetic = bundle([
      cookie({ name: 'host_only' }),
      cookie({ name: 'domain_wide', domain: '.example.com', hostOnly: false, sameSite: 'strict' }),
      cookie({ name: 'session_only', session: true, expirationDate: undefined }),
      cookie({
        name: 'partitioned',
        domain: 'embed.example.com',
        sameSite: 'no_restriction',
        partitionKey: { topLevelSite: 'https://example.net', hasCrossSiteAncestor: true },
      }),
    ]).cookies;
    checks.syncCounts = await timed('syncCookies', () =>
      session.syncCookies({
        clearSites: ['example.com'],
        cookies: synthetic.map(toCdpCookie),
        budgetMs: SYNC_BUDGET_MS,
      }),
    );
    type Jar = {
      name: string;
      domain: string;
      session: boolean;
      partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
    };
    const jar: Jar[] = JSON.parse(await session.cdp({ method: 'Storage.getCookies' })).result?.cookies ?? [];
    const named = (name: string) => jar.find(entry => entry.name === name);
    checks.sync = {
      computerSiteKept: named('computer_sid')?.domain === 'example.org',
      staleCleared: !named('stale'),
      hostOnlyStaysHostOnly: named('host_only')?.domain === 'example.com',
      domainCookie: named('domain_wide')?.domain === '.example.com',
      sessionCookie: named('session_only')?.session === true,
      partitionKey: named('partitioned')?.partitionKey ?? null,
    };
  }
  await timed('actClick', () => session.act({ type: 'click', x: 640, y: 400, button: 'left', double: false }));
  await timed('actChord', () => session.act({ type: 'key', keys: ['ctrl', 'l'] }));
  await timed('actType', () => session.act({ type: 'type', text: 'clutchbox' }));
  await timed('actKey', () => session.act({ type: 'key', keys: 'Escape' }));
  await timed('actScroll', () => session.act({ type: 'scroll', x: 640, y: 400, direction: 'down', amount: 3 }));
  await writeFile(join(out, 'computer-smoke.png'), await timed('screenshot', () => session.screenshot()));
  const exec = await timed('exec', () =>
    session.exec({
      command: 'mkdir -p ~/Downloads && printf "a,b\\n1,2\\n" > ~/Downloads/smoke.csv && whoami && pwd',
      timeoutSeconds: 20,
    }),
  );
  checks.exec = { exitCode: exec.exitCode, stdout: exec.stdout.trim().split('\n') };
  checks.execFailure = (await session.exec({ command: 'exit 3', timeoutSeconds: 10 })).exitCode;
  checks.execTimeout = (await session.exec({ command: 'sleep 5', timeoutSeconds: 1 })).timedOut;
  await timed('setTimeout', () => session.setTimeout(CALL_HOLD_MS));
  await timed('pause', () => provider.pause(sandboxId!));
  session = await timed('resume', () => provider.connect(sandboxId!, CALL_HOLD_MS));
  const afterResume = JSON.parse(
    await session.cdp({
      method: 'Runtime.evaluate',
      params: { expression: 'location.href', returnByValue: true },
      targetId: page?.targetId,
    }),
  );
  checks.statePreservedAfterResume = afterResume.result?.result?.value;
  // A fork: a snapshot of this computer, and a new computer from it with the same page and files.
  snapshotId = await timed('snapshot', () => provider.snapshot(sandboxId!, CALL_HOLD_MS));
  forkId = await timed('createFromSnapshot', () =>
    provider.createFromSnapshot(snapshotId!, forkComputerId, CALL_HOLD_MS),
  );
  checks.forkFoundByMetadata = (await provider.find(forkComputerId)) === forkId;
  const fork = await provider.connect(forkId, CALL_HOLD_MS);
  const forkPage = JSON.parse(
    await fork.cdp({
      method: 'Runtime.evaluate',
      params: { expression: 'location.href', returnByValue: true },
      targetId: page?.targetId,
    }),
  );
  checks.forkKeepsPage = forkPage.result?.result?.value;
  checks.forkKeepsFile = (await fork.exec({ command: 'cat ~/Downloads/smoke.csv', timeoutSeconds: 10 })).stdout;
  checks.fileAfterResume = (await session.exec({ command: 'cat ~/Downloads/smoke.csv', timeoutSeconds: 10 })).stdout;
  // computer_close leaves one blank tab for the next task.
  await session.cdp({ method: 'Target.createTarget', params: { url: 'https://example.org' } });
  await timed('closeTabs', () => session.closeTabs());
  checks.tabsAfterClose = await tabUrls();
  await writeFile(join(out, 'computer-smoke-resumed.png'), await session.screenshot());
  if (process.env.SMOKE_REFRESH === '1') {
    const root = (command: string) => session.exec({ command: `sudo -n sh -c '${command}'`, timeoutSeconds: 30 });
    const chromeArgs = async () =>
      (await session.exec({ command: 'ps -o args= -C chrome | head -1', timeoutSeconds: 10 })).stdout;
    // Stale like a computer from an older template: Chrome on the old flags, an old helper, no revision.
    await session.cdp({
      method: 'Storage.setCookies',
      params: {
        cookies: [
          {
            name: 'smoke_restart_kept',
            value: 'yes',
            url: 'https://example.com/',
            path: '/',
            secure: true,
            expires: 2_000_000_000,
          },
        ],
      },
    });
    // Chrome writes new cookies to its store about 30 s later, not at once, so a restart before then could lose this
    // one however gracefully Chrome exits, which failed cookieKeptAcrossRestart now and then. Wait for it on disk:
    // the check is that a restart and a refresh keep the profile's cookies.
    await session.exec({
      command:
        'for i in $(seq 1 90); do grep -aqs smoke_restart_kept /home/user/.config/agent-computers-chrome/Default/Cookies* && exit 0; sleep 0.5; done; exit 1',
      timeoutSeconds: 50,
    });
    await root(
      `rm -f ${REVISION_FILE} && sed -i "s/--ignore-gpu-blocklist --disable-gpu-compositing/--no-sandbox --test-type/" ${HELPER_DIR}/ensure-chrome.sh`,
    );
    // Waits for the graceful exit, as refresh does.
    await session.exec({
      command:
        'pkill -TERM -o -x chrome; for i in $(seq 1 30); do pgrep -x chrome >/dev/null || exit 0; sleep 0.5; done; exit 1',
      timeoutSeconds: 20,
    });
    await session.exec({ command: `${HELPER_DIR}/ensure-chrome.sh`, timeoutSeconds: 45 });
    checks.staleChrome = (await chromeArgs()).includes('--no-sandbox');
    checks.refresh = await timed('refresh', () => session.refresh(REFRESH_BUDGET_MS));
    const args = await chromeArgs();
    checks.refreshedChrome = args.includes('--ignore-gpu-blocklist') && !args.includes('--no-sandbox');
    checks.revision =
      (await session.exec({ command: `cat ${REVISION_FILE}`, timeoutSeconds: 10 })).stdout.trim() === REVISION;
    const jar: { name: string; value: string }[] =
      JSON.parse(await session.cdp({ method: 'Storage.getCookies' })).result?.cookies ?? [];
    checks.cookieKeptAcrossRestart = jar.some(entry => entry.name === 'smoke_restart_kept' && entry.value === 'yes');
    checks.refreshAgain = await timed('refreshCurrent', () => session.refresh(REFRESH_BUDGET_MS));
    await writeFile(join(out, 'computer-smoke-refreshed.png'), await session.screenshot());
  }
  // Live view. The stream replaces an x11vnc started without -noprimary, as computers ran it before.
  await session.exec({
    command:
      'mkdir -p /tmp/live-view && (setsid nohup x11vnc -display :0 -rfbport 0 -rfbportv6 -1 -unixsock /tmp/live-view/vnc.sock -forever -shared -nopw -quiet >/dev/null 2>&1 </dev/null &); sleep 1',
    timeoutSeconds: 10,
  });
  const stream = await timed('stream', () => session.stream(15_000));
  checks.x11vncArgs = (
    await session.exec({ command: 'pgrep -a -x x11vnc | cut -d" " -f2-', timeoutSeconds: 10 })
  ).stdout.trim();
  // Then a viewer that collects what x11vnc sends of the clipboard (ServerCutText), as the page decodes it: UTF-8.
  const viewer = new WebSocket(stream.url, 'binary', { headers: stream.headers });
  const connected = Date.now();
  let received = Buffer.alloc(0);
  viewer.on('message', data => {
    received = Buffer.concat([received, data as Buffer]);
  });
  await new Promise((resolve, reject) => viewer.once('open', resolve).once('error', reject));
  const take = async (length: number) => {
    for (const end = Date.now() + 10_000; received.length < length; await sleep(50))
      if (Date.now() > end) throw new Error('viewer read timed out');
    const out = received.subarray(0, length);
    received = received.subarray(length);
    return out;
  };
  checks.greeting = (await take(12)).toString();
  viewer.send(Buffer.from('RFB 003.008\n'));
  await take((await take(1))[0]!);
  viewer.send(Buffer.of(1));
  await take(4);
  viewer.send(Buffer.of(1));
  await take((await take(24)).readUInt32BE(20));
  const cuts: string[] = [];
  const cutTexts = async () => {
    // Without update requests, x11vnc sends only cut text (3) and bells (2).
    while (received.length > 0)
      if (received[0] === 2) received = received.subarray(1);
      else cuts.push((await take((await take(8)).readUInt32BE(4))).toString('utf8'));
    return cuts;
  };
  // Live view's paste: each paste takes the clipboard anew, so two in a row both land, UTF-8 intact.
  const pasteUrl = 'data:text/html,<textarea style="width:100vw;height:100vh"></textarea>';
  await session.cdp({ method: 'Target.createTarget', params: { url: pasteUrl } });
  await sleep(1500);
  const textarea = JSON.parse(await session.cdp({ method: 'Target.getTargets' })).result.targetInfos.find(
    (target: { url: string }) => target.url.startsWith('data:'),
  ).targetId;
  const evaluate = async (expression: string) =>
    JSON.parse(
      await session.cdp({
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true },
        targetId: textarea,
      }),
    ).result?.result?.value;
  await session.act({ type: 'click', x: 640, y: 400, button: 'left', double: false });
  const texts = ['café “quoted” 日本語', 'second ✓ 🎉 — done'];
  checks.pasted = [];
  for (const text of texts) {
    await timed('setClipboard', () => session.setClipboard(text, CLIPBOARD_SET_MS));
    await session.act({ type: 'key', keys: ['ctrl', 'a'] });
    await session.act({ type: 'key', keys: ['ctrl', 'v'] });
    await sleep(300);
    (checks.pasted as string[]).push(await evaluate('document.querySelector("textarea").value'));
  }
  const helperRunning = async () =>
    (await session.exec({ command: 'kill -0 $(cut -d" " -f1 /tmp/live-view/clipboard.pid)', timeoutSeconds: 10 }))
      .exitCode === 0;
  checks.helperServing = await helperRunning();
  // x11vnc's first clipboard read waits 15 s from the first viewer: then it sends the pasted text, which the page writes
  // to the user's clipboard, so it must arrive as UTF-8 rather than lossy Latin-1.
  await sleep(Math.max(0, connected + 17_000 - Date.now()));
  checks.echo = (await cutTexts()).at(-1);
  // A copy in Chrome takes the clipboard back, which ends the helper, and reaches the viewer.
  await evaluate('document.querySelector("textarea").value = "copied ✓ 日本"');
  await session.act({ type: 'key', keys: ['ctrl', 'a'] });
  await session.act({ type: 'key', keys: ['ctrl', 'c'] });
  await sleep(2500);
  checks.helperAfterCopy = await helperRunning();
  checks.copied = (await cutTexts()).at(-1);
  // A paste over 128 KiB still lands, but x11vnc gets no STRING of it, which it would garble (set-clipboard.py).
  const large = `${'long ✓ '.repeat(30_000)}end`;
  const echoed = cuts.length;
  await timed('setClipboardLarge', () => session.setClipboard(large, CLIPBOARD_SET_MS));
  await session.act({ type: 'key', keys: ['ctrl', 'a'] });
  await session.act({ type: 'key', keys: ['ctrl', 'v'] });
  await sleep(2500);
  checks.pastedLarge =
    (await evaluate('(v => v.length + ":" + v.slice(-12))(document.querySelector("textarea").value)')) ===
    `${large.length}:${large.slice(-12)}`;
  checks.largeEchoes = (await cutTexts()).length - echoed;
  // Overlapping pastes both take the clipboard, one after the other, and leave one helper serving it.
  checks.overlapping = (
    await Promise.allSettled(['one', 'two'].map(text => session.setClipboard(text, CLIPBOARD_SET_MS)))
  ).map(result => result.status);
  checks.helpers = (
    await session.exec({ command: "sleep 0.5; pgrep -c -f '^python3 .*set-clipboard'", timeoutSeconds: 10 })
  ).stdout.trim();
  viewer.terminate();
} finally {
  if (forkId) await provider.kill(forkId);
  if (sandboxId) await provider.kill(sandboxId);
  checks.killed = !!sandboxId && !(await provider.find(computerId));
  // Only once the fork made from it is gone: the provider refuses earlier.
  if (snapshotId)
    checks.snapshotDeleted = await provider.deleteSnapshot(snapshotId).then(
      () => true,
      () => false,
    );
  console.log(JSON.stringify({ checks, timingsMs: timings }, null, 2));
}
// Fails the run (CI builds the template, then runs this) when a check is missing or differs.
const expected: Record<string, unknown> = {
  findByMetadata: true,
  cdpPage: true,
  cdpTitle: 'Example Domain',
  exec: { exitCode: 0, stdout: ['user', '/home/user'] },
  execFailure: 3,
  execTimeout: true,
  statePreservedAfterResume: 'https://example.com/',
  forkFoundByMetadata: true,
  forkKeepsPage: 'https://example.com/',
  forkKeepsFile: 'a,b\n1,2\n',
  snapshotDeleted: true,
  fileAfterResume: 'a,b\n1,2\n',
  tabsAfterClose: ['about:blank'],
  killed: true,
  x11vncArgs:
    'x11vnc -display :0 -rfbport 0 -rfbportv6 -1 -unixsock /tmp/live-view/vnc.sock -noprimary -forever -shared -nopw -quiet',
  greeting: 'RFB 003.008\n',
  pasted: ['café “quoted” 日本語', 'second ✓ 🎉 — done'],
  helperServing: true,
  echo: 'second ✓ 🎉 — done',
  helperAfterCopy: false,
  copied: 'copied ✓ 日本',
  pastedLarge: true,
  largeEchoes: 0,
  overlapping: ['fulfilled', 'fulfilled'],
  helpers: '1',
  ...(process.env.SMOKE_SYNC === '1' && {
    sync: {
      computerSiteKept: true,
      staleCleared: true,
      hostOnlyStaysHostOnly: true,
      domainCookie: true,
      sessionCookie: true,
      partitionKey: { topLevelSite: 'https://example.net', hasCrossSiteAncestor: true },
    },
  }),
  ...(process.env.SMOKE_REFRESH === '1' && {
    staleChrome: true,
    refresh: 'refreshed',
    refreshedChrome: true,
    revision: true,
    cookieKeptAcrossRestart: true,
    refreshAgain: 'current',
  }),
};
const failed = Object.keys(expected).filter(key => JSON.stringify(checks[key]) !== JSON.stringify(expected[key]));
if (failed.length) {
  console.error(`Failed checks: ${failed.join(', ')}`);
  process.exitCode = 1;
}
