import { type Capture, captureSchema } from '@clutchbox/capture';

// The Clutchbox TypeScript SDK: the developer REST API (/api/v1) of a Clutchbox server, under an organization API key
// (`ack_…`) that an owner or admin creates on its Developers page. Read a member's latest synced sign-ins, or open a
// computer session for a member on a fork of their computer, already signed in, and drive its Chrome from your own
// framework over the session's CDP URL.

export type ClientOptions = {
  // The server's origin, such as https://www.clutchbox.dev, or its API's when it has its own (the `api` in its
  // /.well-known/agent-computers.json).
  server: string;
  apiKey: string;
  // Your own fetch, if not the global one.
  fetch?: typeof fetch;
};

// A refusal, with the server's error code: unauthenticated (a wrong or deleted key), insufficient_scope (the key lacks
// the scope), not_found, no_capture, session_not_found, session_ended, busy, user_in_control, credit_exhausted,
// provider_account_refused, computer_unavailable, and others. `message` says what to do, when the server says.
export class ClutchboxError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly busyUntil?: string,
  ) {
    super(message ? `Clutchbox answered ${status} ${code}: ${message}` : `Clutchbox answered ${status} ${code}`);
  }
}

export type Member = { id: string; name: string; email: string; role: string; lastSyncedAt: string | null };
// One of a member's browsers, each its own Chrome profile on their computers with that browser's sign-ins, so a site can
// be signed in as a different person in each. The default is the one that synced last.
export type Profile = {
  id: string;
  browser: 'chrome' | 'edge' | 'opera' | null;
  platform: 'macos' | 'windows' | 'linux' | 'chromeos' | null;
  lastSyncedAt: string;
  default: boolean;
};
export type LatestCapture = { member: string; profile: string; completedAt: string; capture: Capture };
// How the session's profile's latest capture applied to the computer when the session opened. cleared: a browser
// stopped syncing, so the computer was signed out of the sites it had synced; sites lists them.
export type SyncSummary = {
  status: 'none' | 'unchanged' | 'applied' | 'cleared' | 'failed';
  captureCompletedAt?: string;
  sitesUpdated?: number;
  sites?: string[];
};
export type ExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  // Less than asked, when the call's time ran short.
  timeoutSeconds?: number;
  // The member had control of the computer in live view since the session's last call.
  userHadControl?: boolean;
};
// open; user_in_control while the member has control in live view, until they hand back; or ended.
export type SessionState = 'open' | 'user_in_control' | 'ended';
export type OpenOptions = {
  // The member's ID, from members.list().
  member: string;
  // A computer to reopen as it was left, by the ID an earlier session returned; without it, a new copy of the member's
  // computer.
  computer?: string;
  // Your current session on that computer, to replace without waiting out its idle minute.
  session?: string;
  // For a new computer: a short name, shown to the member.
  label?: string;
  // The profile to use, by its ID from a session's profiles. Without it, a reopened computer keeps the profile it had,
  // and a new one gets the default.
  profile?: string;
  // The screen size to switch the computer to, in pixels; without it, the computer keeps its own, and a new one starts
  // at 1440x900.
  screen?: '1440x900' | '1280x1024' | '1920x1200';
};

type SessionAnswer = {
  session: string;
  computer: { id: string; label: string | null; created: boolean };
  cdpUrl: string;
  liveViewUrl: string;
  // The session's profile, null when no browser syncs to the member, and all of theirs.
  profile: Profile | null;
  profiles: Profile[];
  sync: SyncSummary;
  idlePauseSeconds: number;
  userHadControl?: boolean;
  // The screen asked for could not be set: the computer predates screen sizes and keeps its own.
  screenUnchanged?: boolean;
};

// How often a kept connection checks whether the member handed back, and the most it waits between failed
// reconnects, which back off from a second.
const USER_IN_CONTROL_RETRY_MS = 5_000;
const MAX_BACKOFF_MS = 15_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function createClient(options: ClientOptions) {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await (options.fetch ?? fetch)(new URL(`/api/v1${path}`, options.server), {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const text = (key: string) => (typeof answer[key] === 'string' ? (answer[key] as string) : undefined);
      throw new ClutchboxError(response.status, text('error') ?? 'error', text('message'), text('busyUntil'));
    }
    return answer as T;
  };
  const session = (id: string) => `/computers/sessions/${encodeURIComponent(id)}`;
  const computers = {
    // Opens a computer session for a member, with their newest sign-ins applied. Needs the computers scope.
    async open(open: OpenOptions) {
      return new ComputerSession(computers, await call<SessionAnswer>('POST', '/computers/sessions', open));
    },
    // Runs one shell command as the desktop user; timeoutSeconds is at most 90.
    exec: (
      sessionId: string,
      command: string,
      { cwd, timeoutSeconds }: { cwd?: string; timeoutSeconds?: number } = {},
    ) => call<ExecResult>('POST', `${session(sessionId)}/exec`, { command, cwd, timeoutSeconds }),
    state: async (sessionId: string) => (await call<{ state: SessionState }>('GET', session(sessionId))).state,
    // Ends the session and pauses its computer, which keeps its tabs and files for the next open.
    close: async (sessionId: string) => {
      await call('DELETE', session(sessionId));
    },
  };
  return {
    members: {
      // The key's organization's members, with when each last synced.
      list: async () => (await call<{ members: Member[] }>('GET', '/members')).members,
    },
    captures: {
      // A member's latest capture, checked against the capture format: the default profile's, or `profile`'s. Needs the
      // captures scope.
      async latest(member: string, { profile }: { profile?: string } = {}): Promise<LatestCapture> {
        const query = profile === undefined ? '' : `?profile=${encodeURIComponent(profile)}`;
        const answer = await call<LatestCapture>('GET', `/members/${encodeURIComponent(member)}/capture${query}`);
        return { ...answer, capture: captureSchema.parse(answer.capture) };
      },
    },
    computers,
  };
}
export type Client = ReturnType<typeof createClient>;
type Computers = Client['computers'];

export type KeepConnectedOptions<T> = {
  // Connects your framework to the CDP URL: chromium.connectOverCDP, for example.
  connect: (cdpUrl: string) => Promise<T>;
  // Resolves once that connection drops: for Playwright, its browser's 'disconnected' event.
  disconnected: (client: T) => Promise<unknown>;
  // Called with each connection, the first and every reconnect.
  onConnect?: (client: T) => void;
  // Called once the session ended, or its key stopped working, so there is nothing to reconnect to.
  onEnd?: () => void;
};
export type Connection<T> = {
  // The latest connection.
  readonly current: T;
  // Stops reconnecting; call it before closing the connection yourself.
  stop(): void;
  // Resolves once it stops reconnecting, whether stopped or ended.
  readonly done: Promise<void>;
};

// One computer session, on a fork of the member's computer. Drive its Chrome over cdpUrl, which only this session can
// use and which works while it is open; send the member liveViewUrl to watch or take control. The CDP connection holds
// the session, and the computer runs, while it lasts. The server closes it before its host's time limit (code 4000), or
// while the member has control (4002), and the session goes on: connect again with the same URL, or let keepConnected
// do it. Close the session when you are done; idle, its computer pauses after a minute, and it ends after ten.
export class ComputerSession {
  readonly id: string;
  readonly computer: SessionAnswer['computer'];
  readonly cdpUrl: string;
  readonly liveViewUrl: string;
  readonly profile: Profile | null;
  readonly profiles: Profile[];
  readonly sync: SyncSummary;
  readonly userHadControl: boolean;
  readonly screenUnchanged: boolean;
  private closed = false;

  constructor(
    private readonly computers: Computers,
    answer: SessionAnswer,
  ) {
    this.id = answer.session;
    this.computer = answer.computer;
    this.cdpUrl = answer.cdpUrl;
    this.liveViewUrl = answer.liveViewUrl;
    this.profile = answer.profile;
    this.profiles = answer.profiles;
    this.sync = answer.sync;
    this.userHadControl = !!answer.userHadControl;
    this.screenUnchanged = !!answer.screenUnchanged;
  }

  exec(command: string, options?: { cwd?: string; timeoutSeconds?: number }) {
    return this.computers.exec(this.id, command, options);
  }
  state() {
    return this.computers.state(this.id);
  }
  // Ends the session; a kept connection stops reconnecting.
  async close() {
    this.closed = true;
    await this.computers.close(this.id);
  }

  // Keeps your framework connected across the server's closes: whenever the connection drops while the session is
  // open, it connects again, at once; while the member has control in live view, once they hand back; and with backoff
  // when a reconnect fails. It stops when the session ends or its key stops working, on stop(), or on close().
  async keepConnected<T>({ connect, disconnected, onConnect, onEnd }: KeepConnectedOptions<T>): Promise<Connection<T>> {
    let current = await connect(this.cdpUrl);
    onConnect?.(current);
    let stopped = false;
    let resolveDone = () => {};
    const done = new Promise<void>(resolve => {
      resolveDone = resolve;
    });
    const backoff = (wait: number) => Math.min(MAX_BACKOFF_MS, Math.max(1_000, wait * 2));
    const watch = async (client: T) => {
      await disconnected(client).catch(() => {});
      let wait = 0;
      while (!stopped && !this.closed) {
        if (wait) await sleep(wait);
        if (stopped || this.closed) break;
        let state: SessionState;
        try {
          state = await this.state();
        } catch (error) {
          // A refusal (a deleted key) ends it; a server or network failure is retried.
          if (error instanceof ClutchboxError && error.status < 500) break;
          wait = backoff(wait);
          continue;
        }
        if (state === 'ended') break;
        if (state === 'user_in_control') {
          wait = USER_IN_CONTROL_RETRY_MS;
          continue;
        }
        try {
          current = await connect(this.cdpUrl);
        } catch {
          wait = backoff(wait);
          continue;
        }
        onConnect?.(current);
        void watch(current);
        return;
      }
      if (!stopped && !this.closed) onEnd?.();
      stopped = true;
      resolveDone();
    };
    void watch(current);
    return {
      get current() {
        return current;
      },
      stop() {
        stopped = true;
        resolveDone();
      },
      done,
    };
  }
}
