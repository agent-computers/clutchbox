import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cookieParamOf, partitionCookies } from '@agent-computers/apply';
import { siteOfHost } from '@agent-computers/capture';
import { Sandbox } from '@e2b/desktop';
import { Sandbox as BaseSandbox, CommandExitError, InvalidArgumentError } from 'e2b';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CDP_HELPER,
  e2bComputerProvider,
  HELPERS,
  PROFILE_FILE,
  REVISION,
  REVISION_FILE,
  STREAM_ORIGIN,
  SYNC_CORE,
} from './index';

// The E2B SDK, mocked: tests stand in a sandbox whose commands they answer.
const e2b = vi.hoisted(() => ({ sandbox: undefined as unknown }));
vi.mock('@e2b/desktop', () => ({ Sandbox: { connect: async () => e2b.sandbox } }));
// A caller's refresh budget.
const REFRESH_BUDGET = 30_000;

describe('in-sandbox cookie sync', () => {
  it('keeps the in-sandbox helper in step with the shared site rules and the open apply runtime', () => {
    const core = new Function(`${SYNC_CORE}; return { siteOfHost, toParam, partition };`)() as {
      siteOfHost: (host: string) => string;
      toParam: (cookie: Record<string, unknown>) => Record<string, unknown>;
      partition: (cookies: { domain: string }[], clear: string[]) => { kept: number; clear: { domain: string }[] };
    };
    for (const host of [
      'example.com',
      '.example.com',
      'mail.google.com',
      'www.bbc.co.uk',
      '.foo.com.au',
      'localhost',
      'a.b.c.example.org.',
      'x.co',
      'EXAMPLE.COM',
      'deep.sub.gov.uk',
      '127.0.0.1',
    ])
      expect(core.siteOfHost(host), host).toBe(siteOfHost(host));
    // The helper runs the open apply runtime's logic inside the computer; both must turn Chrome's cookies back into the
    // same params and clear the same sites.
    const cdp = { name: 'n', value: 'v', path: '/', secure: true, httpOnly: false, size: 2, sourcePort: 443 };
    for (const held of [
      { ...cdp, domain: 'host.test', expires: -1, session: true, priority: 'Medium' },
      { ...cdp, domain: '.dom.test', expires: 2e9, session: false, sameSite: 'None' as const },
      { ...cdp, domain: 'embed.test', expires: 2e9, session: false, partitionKey: 'https://top.test' },
      {
        ...cdp,
        domain: '.part.test',
        expires: 2e9,
        session: false,
        partitionKey: { topLevelSite: 'https://top.test', hasCrossSiteAncestor: true },
      },
    ])
      expect(core.toParam(held), held.domain).toEqual(cookieParamOf(held));
    const held = [{ domain: '.github.com' }, { domain: 'api.github.com' }, { domain: 'google.com' }];
    expect(core.partition(held, ['github.com'])).toEqual(partitionCookies(held, ['github.com']));
  });
});

describe('E2B cookie sync budget', () => {
  // A stand-in sandbox whose commands take `slow(command)` ms of mocked clock time.
  const sandbox = (slow: (command: string) => number = () => 0, { current = false } = {}) => {
    const now = Date.now.bind(Date);
    let elapsed = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now() + elapsed);
    const steps: { command: string; timeoutMs: number; user: string | undefined }[] = [];
    e2b.sandbox = {
      commands: {
        run: async (command: string, { timeoutMs, user }: { timeoutMs: number; user?: string }) => {
          steps.push({ command, timeoutMs, user });
          elapsed += slow(command);
          if (current && command.includes(REVISION_FILE)) return { stdout: 'current\n' };
          return { stdout: command.includes('sync-cookies.mjs') ? '{"kept":0,"cleared":0,"set":1}' : '' };
        },
      },
      files: {
        write: async (_files: unknown, { requestTimeoutMs }: { requestTimeoutMs: number }) => {
          steps.push({ command: 'write', timeoutMs: requestTimeoutMs, user: undefined });
        },
        remove: async () => {},
      },
    };
    return steps;
  };
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("bounds every step, the lock wait, and the helper's own exit timer by the budget", async () => {
    // Real time also passes, so leave the helper more than its 5s minimum after Chrome's 4s and the 3s margin.
    const budgetMs = 13_000;
    const steps = sandbox(command => (command.includes('ensure-chrome') ? 4_000 : 0));
    const session = await e2bComputerProvider().connect('sandbox', 300_000);
    expect(await session.syncCookies({ profile: 'default', clearSites: [], cookies: [], budgetMs })).toEqual({
      kept: 0,
      cleared: 0,
      set: 1,
    });
    for (const step of steps) expect(step.timeoutMs).toBeLessThanOrEqual(budgetMs);
    const helper = steps.at(-1)!;
    const [, wait, exit] = helper.command.match(/flock -w (\d+) .*sync-[^ ]+\.json (\d+)'/)!;
    // Under the lock, the helper runs only while Chrome runs the profile it was given.
    expect(helper.command).toContain(
      `sh -c 'test "$(cat ${PROFILE_FILE} 2>/dev/null || echo default)" = default && exec node`,
    );
    // The helper is done inside the run's own timeout, which ends by the budget.
    expect(Number(wait) * 1000 + Number(exit)).toBeLessThan(helper.timeoutMs);
    expect(helper.timeoutMs).toBeLessThanOrEqual(budgetMs - 4_000);
  });
  it('refreshes a stale computer inside its budget, and only checks a current one (E2B adapter)', async () => {
    const steps = sandbox(command => (command.includes('ensure-chrome') ? 4_000 : 0));
    const session = await e2bComputerProvider().connect('sandbox', 300_000);
    expect(await session.refresh(REFRESH_BUDGET)).toBe('refreshed');
    const [write, stop, start, stamp] = steps;
    // Every helper is written whole, as the template build writes it.
    const written = Object.fromEntries(
      [...write!.command.matchAll(/echo (\S+) \| base64 -d > \S+\/([^/ ]+)\.new/g)].map(([, data, name]) => [
        name,
        Buffer.from(data!, 'base64').toString(),
      ]),
    );
    expect(written).toEqual(Object.fromEntries(HELPERS.map(helper => [helper.name, helper.content])));
    expect(write!.user).toBe('root');
    expect(stop!.command).toMatch(/^pkill -TERM -o -x chrome/);
    expect(start!.command).toContain('ensure-chrome.sh');
    expect(stamp).toMatchObject({ command: `echo ${REVISION} > ${REVISION_FILE}`, user: 'root' });
    expect(steps).toHaveLength(4);
    for (const step of steps) expect(step.timeoutMs).toBeLessThanOrEqual(REFRESH_BUDGET);
    vi.restoreAllMocks();
    const checked = sandbox(() => 0, { current: true });
    expect(await (await e2bComputerProvider().connect('sandbox', 300_000)).refresh(REFRESH_BUDGET)).toBe('current');
    expect(checked).toHaveLength(1);
  });
  it('switches profiles with the helper, or on older helpers runs only the first profile (E2B adapter)', async () => {
    const steps = sandbox();
    const session = await e2bComputerProvider().connect('sandbox', 300_000);
    await session.useProfile('brw_0abc', REFRESH_BUDGET);
    await session.useProfile('default', REFRESH_BUDGET);
    expect(steps.map(step => [step.command, step.user, step.timeoutMs])).toEqual([
      [
        'if [ -x /opt/agent-computers/use-profile.sh ]; then /opt/agent-computers/use-profile.sh brw_0abc 10; else exit 3; fi',
        'user',
        REFRESH_BUDGET,
      ],
      [
        'if [ -x /opt/agent-computers/use-profile.sh ]; then /opt/agent-computers/use-profile.sh default 10; else /opt/agent-computers/ensure-chrome.sh; fi',
        'user',
        REFRESH_BUDGET,
      ],
    ]);
    await expect(session.useProfile('../other', REFRESH_BUDGET)).rejects.toThrow('Invalid profile');
    await expect(
      session.syncCookies({ profile: 'a b', clearSites: [], cookies: [], budgetMs: REFRESH_BUDGET }),
    ).rejects.toThrow('Invalid profile');
    expect(steps).toHaveLength(2);
  });
  it('never starts the helper once the budget is used up', async () => {
    const steps = sandbox(command => (command.includes('ensure-chrome') ? 11_000 : 0));
    const session = await e2bComputerProvider().connect('sandbox', 300_000);
    await expect(
      session.syncCookies({ profile: 'default', clearSites: [], cookies: [], budgetMs: 12_000 }),
    ).rejects.toThrow('cookie sync failed');
    expect(steps.map(step => step.command)).toEqual([expect.stringContaining('ensure-chrome')]);
  });
});

describe('E2B adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('turns a missing exec cwd into a failed command and a stopped Chrome into a CDP error (E2B adapter)', async () => {
    // Mirrors envd: an unknown cwd is an SDK error, a non-zero exit is CommandExitError.
    const run = vi.fn(async (command: string, options: { cwd?: string }) => {
      if (options.cwd) throw new InvalidArgumentError('cwd does not exist');
      if (command.startsWith("cd -- '/missing'"))
        throw new CommandExitError({
          exitCode: 1,
          error: 'exit status 1',
          stdout: '',
          stderr: 'bash: line 1: cd: /missing: No such file or directory\n',
        });
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    });
    vi.spyOn(Sandbox, 'connect').mockResolvedValue({ commands: { run } } as never);
    const session = await e2bComputerProvider().connect('sandbox', 1000);
    expect(await session.exec({ command: 'ls', cwd: '/missing', timeoutSeconds: 5 })).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('No such file'),
      timedOut: false,
    });
    expect(run).toHaveBeenLastCalledWith(
      "cd -- '/missing' || exit 1\nls",
      expect.not.objectContaining({ cwd: expect.anything() }),
    );
    expect(await session.exec({ command: 'ls', timeoutSeconds: 5 })).toMatchObject({ exitCode: 0, stdout: 'ok' });
    // The template's CDP helper, with Chrome unreachable (fetch rejects; no network).
    const dir = mkdtempSync(join(tmpdir(), 'cdp-helper-'));
    const helper = join(dir, 'cdp.mjs');
    writeFileSync(helper, CDP_HELPER);
    const offline = 'data:text/javascript,globalThis.fetch=()=>Promise.reject(new Error("refused"))';
    const output = spawnSync(
      process.execPath,
      ['--import', offline, helper, Buffer.from(JSON.stringify({ method: 'Target.getTargets' })).toString('base64')],
      { encoding: 'utf8', timeout: 10_000 },
    );
    rmSync(dir, { recursive: true, force: true });
    expect({ status: output.status, stdout: output.stdout.trim() }).toEqual({
      status: 0,
      stdout: '{"error":"cdp_unavailable"}',
    });
  });
  it('keeps key names and time zones off the command line unless they are plain names', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const press = vi.fn(async () => {});
    vi.spyOn(Sandbox, 'connect').mockResolvedValue({ commands: { run }, press } as never);
    const session = await e2bComputerProvider().connect('sandbox', 1000);
    // E2B's press runs `xdotool key <keys>` in a shell.
    await expect(session.act({ type: 'key', keys: ['ctrl', 'a;touch /tmp/owned'] })).rejects.toThrow('key name');
    await expect(session.act({ type: 'key', keys: '$(id)' })).rejects.toThrow('key name');
    expect(press).not.toHaveBeenCalled();
    await session.act({ type: 'key', keys: ['ctrl', 'Page_Down'] });
    expect(press).toHaveBeenCalledWith(['ctrl', 'Page_Down']);
    // Run as root on a path built from the name.
    await expect(session.setTimeZone('../../../etc/shadow')).rejects.toThrow('time zone');
    expect(run).not.toHaveBeenCalled();
    await session.setTimeZone('America/Los_Angeles');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('creates private computers and starts live view only on one with a traffic token (E2B adapter)', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const create = vi
      .spyOn(BaseSandbox, 'create')
      .mockResolvedValue({ sandboxId: 'sandbox', commands: { run } } as never);
    expect(await e2bComputerProvider('template').create('cm_1', 60_000)).toBe('sandbox');
    expect(create).toHaveBeenCalledWith(
      'template',
      expect.objectContaining({ network: { allowPublicTraffic: false }, timeoutMs: 60_000 }),
    );
    const setTimeout = vi.spyOn(BaseSandbox, 'setTimeout').mockResolvedValue();
    await e2bComputerProvider().setTimeout('sandbox', 5_000);
    expect(setTimeout).toHaveBeenCalledWith('sandbox', 5_000, expect.objectContaining({ requestTimeoutMs: 15_000 }));
    // A computer made before private computers has no token: its stream would be public.
    vi.spyOn(Sandbox, 'connect').mockResolvedValue({ commands: { run } } as never);
    const legacy = await e2bComputerProvider().connect('sandbox', 1000);
    expect(legacy.isPrivate).toBe(false);
    await expect(legacy.stream(15_000)).rejects.toThrow('public traffic');
    expect(run).toHaveBeenCalledTimes(1);
    vi.spyOn(Sandbox, 'connect').mockResolvedValue({
      commands: { run },
      trafficAccessToken: 'token',
      getHost: (port: number) => `${port}-sandbox.e2b.app`,
    } as never);
    const session = await e2bComputerProvider().connect('sandbox', 1000);
    expect(session.isPrivate).toBe(true);
    // websockify accepts only this Origin, which no page in the computer's Chrome can send.
    expect(await session.stream(15_000)).toEqual({
      url: 'wss://6080-sandbox.e2b.app/',
      headers: { 'e2b-traffic-access-token': 'token', origin: STREAM_ORIGIN },
    });
    expect(run).toHaveBeenLastCalledWith(
      expect.stringContaining('/opt/agent-computers/live-view-stream.sh'),
      expect.objectContaining({ user: 'user', timeoutMs: 15_000 }),
    );
  });
  it('sets the clipboard from a file the helper deletes, and removes it when the helper fails (E2B adapter)', async () => {
    const write = vi.fn(async () => ({}));
    const remove = vi.fn(async () => {});
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockRejectedValueOnce(new CommandExitError({ exitCode: 1, error: 'exit status 1', stdout: '', stderr: '' }));
    vi.spyOn(Sandbox, 'connect').mockResolvedValue({ commands: { run }, files: { write, remove } } as never);
    const session = await e2bComputerProvider().connect('sandbox', 1000);
    await session.setClipboard('secret 日本語', 10_000);
    const [[file, text, options]] = write.mock.calls as unknown as [[string, string, { user: string }]];
    expect({ file, text, user: options.user }).toEqual({
      file: expect.stringMatching(/^\/tmp\/live-view\/clipboard-[0-9a-f-]{36}$/),
      text: 'secret 日本語',
      user: 'user',
    });
    // The helper from HELPER_DIR, or inline on a computer not yet refreshed; the text never goes in the command.
    const [command, runOptions] = run.mock.calls[0]!;
    expect(command).toContain(`python3 /opt/agent-computers/set-clipboard.py ${file}`);
    expect(command).not.toContain('secret');
    expect(runOptions).toMatchObject({ user: 'user', envs: { DISPLAY: ':0' } });
    expect(remove).not.toHaveBeenCalled();
    const failed = session.setClipboard('secret again', 10_000);
    await expect(failed).rejects.toThrow('set-clipboard exited 1');
    await failed.catch((error: Error) => expect(error.message).not.toContain('secret'));
    expect(remove).toHaveBeenCalledWith((write.mock.calls[1] as unknown as [string])[0], expect.anything());
  });
  it('fails within its budget on a stalled computer, removal included (E2B adapter)', async () => {
    vi.useFakeTimers();
    // A stalled computer: each call runs to its own timeout.
    const stall = (ms: number) => new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms));
    const write = vi.fn(async () => ({}));
    const run = vi.fn((_: string, options: { timeoutMs: number }) => stall(options.timeoutMs));
    const remove = vi.fn((_: string, options: { requestTimeoutMs: number }) => stall(options.requestTimeoutMs));
    vi.spyOn(Sandbox, 'connect').mockResolvedValue({ commands: { run }, files: { write, remove } } as never);
    const session = await e2bComputerProvider().connect('sandbox', 1000);
    const start = Date.now();
    const failed = session.setClipboard('text', 10_000).catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await failed).toBeInstanceOf(Error);
    expect(remove).toHaveBeenCalled();
    expect(Date.now() - start).toBeLessThanOrEqual(10_000);
  });
  // Opt-in: LIVE_E2B=1 with E2B_API_KEY. Creates and always deletes one real computer.
});
