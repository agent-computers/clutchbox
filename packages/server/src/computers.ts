import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cookieChanges, expiredCdpCookie, toCdpCookie } from '@agent-computers/apply';
import { siteOfCookie } from '@agent-computers/capture';
import { type ComputerProvider, type ComputerSession, FIRST_PROFILE } from '@agent-computers/computer';
import { and, desc, eq, getTableColumns, gt, gte, inArray, isNotNull, isNull, lt, min, or, sql } from 'drizzle-orm';
import { type AgentKind, agentOf, clientHost } from './agents';
import {
  captureView,
  latestCaptureDigest,
  listProfiles,
  loadLatestCapture,
  openAppliedCapture,
  type Profile,
  sealAppliedCapture,
} from './captures';
import {
  CALL_BUDGET_MS,
  CALL_HOLD_MS,
  CLIPBOARD_SET_MS,
  CREATE_STALE_MS,
  FORK_UNUSED_MS,
  HOLD_EXTEND_STEP_MS,
  HOLD_LAPSE_MS,
  IDLE_PAUSE_MS,
  PROFILE_SWITCH_BUDGET_MS,
  REFRESH_BUDGET_MS,
  RELEASED_LEASE_MS,
  SESSION_IDLE_END_MS,
  SNAPSHOT_HOLD_MS,
  SYNC_BUDGET_MS,
  SYNC_DEADLINE_MS,
  SYNC_MIN_MS,
  SYNC_SLACK_MS,
} from './computer-timing';
import type { Database } from './database';
import type { Metering } from './hooks';
import { newPublicId, publicIdPattern } from './ids';
import { logError } from './log';
import type { Member } from './organizations';
import * as schema from './schema';
import type { Owner } from './sealing';
import { markToolStep } from './tool-calls';

// Each member (a person in one organization) has one main computer, which only the member changes, by taking it over in
// live view, and agents work in forks of it (Forks, below), each controlled by one computer session at a time. Timings
// are in computer-timing.ts.
// Server-issued computer session IDs; access is checked against the caller, never the ID alone.
export const SESSION_ID_PATTERN = publicIdPattern('computerSession');
// A fork's ID, which agents reopen it by; like a session's, it works only for the member whose fork it is.
export const COMPUTER_ID_PATTERN = publicIdPattern('computer');
// The provider interfaces live in @agent-computers/computer; re-exported for this service's callers.
export {
  actionSchema,
  type ComputerAction,
  type ComputerProvider,
  type ComputerSession,
  DISPLAY,
  type ExecResult,
} from '@agent-computers/computer';

export type ComputerFailure = {
  error:
    | 'starting'
    | 'busy'
    | 'user_in_control'
    | 'session_not_found'
    | 'session_ended'
    | 'allowance_exhausted'
    | 'access_revoked'
    | 'needs_reset'
    | 'computer_not_found'
    | 'profile_not_found';
  message: string;
  busyUntil?: Date | undefined;
  resetsAt?: Date | undefined;
};
export type SyncSummary = {
  // `none`: the session has no profile, since no browser syncs to the member, and nothing needed signing out.
  // `cleared`: a browser stopped syncing to the member, so the computer was signed out of the sites its profile had
  // synced; with no profile left, the session's own summary.
  status: 'none' | 'unchanged' | 'applied' | 'cleared' | 'failed';
  captureCompletedAt?: string | undefined;
  sitesUpdated?: number | undefined;
  // For `cleared`, the sites signed out; for a `failed` sign-out, the sites still signed in.
  sites?: string[] | undefined;
};
export type SessionHandle = {
  sessionId: string;
  session: ComputerSession;
  // The user had control of the computer in live view since this session's last call; said once.
  userHadControl?: boolean | undefined;
  // Ends the call: lets the computer pause after the idle minute.
  // Call it once the call's work is done, on every path; repeat calls are no-ops. Never throws.
  done(): Promise<void>;
};
// Re-checks the caller's access inside the control transaction (MCP: the live grant), so an in-flight
// call cannot take control after a revocation ended its sessions. Revocation locks the same user row.
export type AccessGuard = (tx: Pick<Database, 'select'>) => Promise<boolean>;
// Who opens and uses a computer session: an MCP client by its OAuth client_id, or an organization API key by its ID
// (the REST API's). A session works only for the member and the agent that opened it.
export type SessionAgent = { clientId: string; apiKeyId?: undefined } | { apiKeyId: string; clientId?: undefined };
export type Caller = Member & SessionAgent & { guard?: AccessGuard | undefined };
// The caller's own sessions, and whether a session is one.
const ownedBy = (caller: Caller) =>
  and(
    eq(schema.computerSessions.membershipId, caller.membershipId),
    caller.apiKeyId !== undefined
      ? eq(schema.computerSessions.apiKeyId, caller.apiKeyId)
      : eq(schema.computerSessions.clientId, caller.clientId),
  );
const isCallers = (session: Pick<SessionRow, 'membershipId' | 'clientId' | 'apiKeyId'>, caller: Caller) =>
  session.membershipId === caller.membershipId &&
  (caller.apiKeyId !== undefined ? session.apiKeyId === caller.apiKeyId : session.clientId === caller.clientId);
// What the computer service runs computers with: the provider, and the metering hook (hooks.ts) it books time to.
export type Computers = { provider: ComputerProvider; metering: Metering };
// Every computers column but the sealed baseline, which can run to megabytes: only the apply and the
// pending notice read it, and only once the capture digest changed.
const { appliedCapture: _baseline, ...computerColumns } = getTableColumns(schema.computers);
type ComputerRow = Omit<typeof schema.computers.$inferSelect, 'appliedCapture'>;
type SessionRow = typeof schema.computerSessions.$inferSelect;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

// The metering refusal (hooks.ts) as the computer service's failure: allowance_exhausted, with when it lifts.
async function allowanceFailure(metering: Metering, db: Database, member: Member): Promise<ComputerFailure | null> {
  const refusal = await metering.refusal(db, member, new Date());
  return refusal && { error: 'allowance_exhausted', ...refusal };
}
// Metering after the fact: books the computer's running time since the last meter, up to when the provider was due
// to pause it, to the metering hook, then records `runsUntil`, when the provider will now pause it. Nothing is
// charged ahead or refunded, so the allowance can be overshot by the calls and live-view holds already running when
// it runs out, and time since the last meter (at most the idle minute after the last call) is booked at the next one.
async function meter(tx: Transaction, metering: Metering, computerId: number, member: Member, runsUntil: Date) {
  const [row] = await tx
    .select({ billedUntil: schema.computers.billedUntil, runsUntil: schema.computers.runsUntil })
    .from(schema.computers)
    .where(eq(schema.computers.id, computerId))
    .for('update');
  if (!row) return;
  const now = new Date();
  const ran = row.runsUntil && row.runsUntil < now ? row.runsUntil : now;
  const seconds = row.billedUntil && row.runsUntil ? Math.ceil((ran.getTime() - row.billedUntil.getTime()) / 1000) : 0;
  await tx
    .update(schema.computers)
    .set({ billedUntil: row.billedUntil && row.billedUntil > now ? row.billedUntil : now, runsUntil })
    .where(eq(schema.computers.id, computerId));
  if (seconds > 0) await metering.charge(tx, member, seconds, now);
}
const running = (computer: Pick<ComputerRow, 'runsUntil'>, now: Date) =>
  !!computer.runsUntil && computer.runsUntil > now;
// The provider runs a computer until timeoutMs after the latest create/connect. Called before the provider call, so
// a failed call still counts as running until then.
const meterRun = (db: Database, metering: Metering, computerId: number, member: Member, timeoutMs: number) =>
  db.transaction(tx => meter(tx, metering, computerId, member, new Date(Date.now() + timeoutMs)));

// The member's main computer row.
const mainOf = (member: Pick<Member, 'membershipId'>) =>
  and(eq(schema.computers.membershipId, member.membershipId), isNull(schema.computers.forkOf));
const resetting: ComputerFailure = {
  error: 'starting',
  message: 'The computer is being reset. Try again in a few seconds.',
};
// Exactly one caller creates the member's main provider computer; others see `starting`.
async function ensureComputer(
  db: Database,
  { provider, metering }: Computers,
  member: Member,
): Promise<ComputerRow | ComputerFailure> {
  const [inserted] = await db
    .insert(schema.computers)
    .values({ membershipId: member.membershipId, publicId: newPublicId('computer') })
    .onConflictDoNothing()
    .returning(computerColumns);
  let row = inserted;
  if (!row) {
    [row] = await db.select(computerColumns).from(schema.computers).where(mainOf(member));
    if (!row) return resetting;
    if (row.status === 'ready') return row;
    const [claimed] = await db
      .update(schema.computers)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(schema.computers.id, row.id),
          eq(schema.computers.status, 'creating'),
          lt(schema.computers.updatedAt, new Date(Date.now() - CREATE_STALE_MS)),
        ),
      )
      .returning(computerColumns);
    if (!claimed) return { error: 'starting', message: 'The computer is starting. Try again in about 30 seconds.' };
    row = claimed;
  }
  let sandboxId = await provider.find(row.publicId);
  if (!sandboxId) {
    await meterRun(db, metering, row.id, member, IDLE_PAUSE_MS);
    markToolStep('create');
    sandboxId = await provider.create(row.publicId, IDLE_PAUSE_MS);
  }
  // Conditional: a delete (or a stale-create takeover that finished first) may have run meanwhile.
  const [ready] = await db
    .update(schema.computers)
    .set({ status: 'ready', sandboxId })
    .where(and(eq(schema.computers.id, row.id), eq(schema.computers.status, 'creating')))
    .returning(computerColumns);
  if (ready) return ready;
  const [current] = await db.select(computerColumns).from(schema.computers).where(eq(schema.computers.id, row.id));
  if (current?.status === 'ready' && current.sandboxId === sandboxId) return current;
  // Paused computers never expire: kill the one no row records, or it is orphaned.
  await provider.kill(sandboxId).catch(() => {
    console.error('Could not kill a provider computer that no row records; it may be orphaned.');
  });
  if (current?.status === 'ready') return current;
  return resetting;
}

// Computer sessions. Live: not ended and not idle for SESSION_IDLE_END_MS (an idle-expired one is
// ended lazily). It holds control while its last call ended less than IDLE_PAUSE_MS ago; a call in flight
// holds it until its deadline. A suspended session (the user's takeover) neither expires nor holds
// control. Lock order everywhere: user row (share), computer row, session row.
type SessionClock = Pick<SessionRow, 'lastCallAt' | 'suspendedAt'>;
const expired = (session: SessionClock, now: Date) =>
  !session.suspendedAt && session.lastCallAt.getTime() <= now.getTime() - SESSION_IDLE_END_MS;
const holdsControl = (session: SessionClock, now: Date) =>
  !session.suspendedAt && session.lastCallAt.getTime() > now.getTime() - IDLE_PAUSE_MS;
// Only the guard reports a revocation: a session that a revocation ended is just ended for a reconnected agent.
const revoked: ComputerFailure = {
  error: 'access_revoked',
  message: 'This agent was disconnected from the account. Reconnect it to continue.',
};
const notFound: ComputerFailure = {
  error: 'session_not_found',
  message: 'No such computer session for this agent. Call computer_open and use the session_id it returns.',
};
const ended: ComputerFailure = {
  error: 'session_ended',
  message:
    "This computer session ended: it was closed, replaced by a newer computer_open (use the session_id that returned), idle for 10 minutes, or superseded by another agent's computer_open after its idle minute. Call computer_open for a new one.",
};
const userInControl: ComputerFailure = {
  error: 'user_in_control',
  message:
    'The user took control of this computer in live view, and your computer session waits until they hand it back. Keep your session_id and try again in a minute or two; do not call computer_open.',
};
const userBusy: ComputerFailure = {
  error: 'busy',
  message: 'The user is controlling this computer in live view. Try again in a few minutes.',
};
async function guardFailure(tx: Transaction, caller: Caller) {
  if (!caller.guard) return null;
  await tx.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, caller.userId)).for('share');
  return (await caller.guard(tx)) ? null : revoked;
}
type EndReason = (typeof schema.SESSION_END_REASONS)[number];
const endSession = (tx: Pick<Database, 'update'>, sessionId: number, reason: EndReason, now = new Date()) =>
  tx
    .update(schema.computerSessions)
    .set({ endedAt: now, endReason: reason })
    .where(and(eq(schema.computerSessions.id, sessionId), isNull(schema.computerSessions.endedAt)));
// The caller's own live session, locked with its computer. Ends an idle-expired one and a lapsed takeover. While
// the user holds a takeover the session is suspended: user_in_control, unless the call is a close.
async function lockSession(
  tx: Transaction,
  caller: Caller,
  sessionId: string,
  now: Date,
  { close = false } = {},
): Promise<{ session: SessionRow; computer: ComputerRow } | ComputerFailure> {
  const own = and(eq(schema.computerSessions.publicId, sessionId), ownedBy(caller));
  const [found] = await tx
    .select({ computerId: schema.computerSessions.computerId })
    .from(schema.computerSessions)
    .where(own);
  if (!found) return notFound;
  let [computer] = await tx
    .select(computerColumns)
    .from(schema.computers)
    .where(eq(schema.computers.id, found.computerId))
    .for('update');
  let [session] = await tx.select().from(schema.computerSessions).where(own).for('update');
  if (!session || computer?.status !== 'ready' || !computer.sandboxId) return notFound;
  // A session on the main computer is from before forks: agents never control main.
  if (session.endedAt || computer.forkOf === null) return ended;
  if (lapsed(computer, now)) {
    computer = await endTakeover(tx, computer, now);
    [session] = await tx.select().from(schema.computerSessions).where(own);
    if (!session) return notFound;
  }
  if (takenOver(computer, now) && !close) return userInControl;
  if (expired(session, now)) {
    await endSession(tx, session.id, 'idle', now);
    return ended;
  }
  return { session, computer };
}

// Calls in flight on a computer, each until its deadline: an entry whose end was lost stops counting then.
const liveCalls = (calls: ComputerRow['callsInFlight'], now: Date) =>
  Object.entries(calls).filter(([, call]) => Date.parse(call.until) > now.getTime());

// Live view holds: pages watching, each until its lapse deadline, and the user's
// takeover, which counts only until takeover_until. A lapsed takeover is ended lazily by whatever next locks the
// computer row; readers that do not lock treat it as ended.
type Watches = ComputerRow['liveViewWatches'];
const liveWatches = (watches: Watches, now: Date) =>
  Object.entries(watches).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && Date.parse(entry[1]) > now.getTime(),
  );
// A lease its page released in the last RELEASED_LEASE_MS: a visible heartbeat sent before the release but handled
// after it must not start a new watch for a page that is gone.
const released = (watches: Watches, lease: string, now: Date) => {
  const entry = watches[lease];
  return typeof entry === 'object' && Date.parse(entry.released) + RELEASED_LEASE_MS > now.getTime();
};
// What a rewrite of the watches keeps: live watches and recent releases.
const keptWatches = (watches: Watches, now: Date): Watches =>
  Object.fromEntries(
    Object.entries(watches).filter(([lease, entry]) =>
      typeof entry === 'string' ? Date.parse(entry) > now.getTime() : released(watches, lease, now),
    ),
  );
// Live watches on one computer at most: a user watches in a tab or two, and the bound keeps a script that makes up
// leases from growing the row or making a provider call for each.
const MAX_LIVE_WATCHES = 8;
const takenOver = (computer: Pick<ComputerRow, 'takeoverUntil'>, now: Date) =>
  !!computer.takeoverUntil && computer.takeoverUntil > now;
const lapsed = (computer: Pick<ComputerRow, 'takeoverUntil'>, now: Date) =>
  !!computer.takeoverUntil && computer.takeoverUntil <= now;
// Ends the takeover (hand-back, release, or lapse), under the computer row lock, and resumes the suspended session
// as of the hand-back, or of the lapse deadline for a lapsed one. The resume moves its last call ahead by
// the suspension, so its idle clock skips it; a call that ended during the suspension counts as ending at the resume.
// Its next call reports that the user had control (handedBackAt). Returns the computer without the takeover.
// On the main computer, the member may have signed in, so the next fork needs a new snapshot (snapshotDueAt).
async function endTakeover<
  C extends Pick<ComputerRow, 'id' | 'forkOf' | 'takeoverUntil' | 'takeoverLease' | 'takenOverAt'>,
>(tx: Transaction, computer: C, now: Date): Promise<C> {
  const resumedAt = computer.takeoverUntil && computer.takeoverUntil < now ? computer.takeoverUntil : now;
  const cleared = { takeoverLease: null, takenOverAt: null, takeoverUntil: null };
  await tx
    .update(schema.computers)
    .set({ ...cleared, ...(computer.forkOf === null ? { snapshotDueAt: now } : {}) })
    .where(eq(schema.computers.id, computer.id));
  const at = sql`${resumedAt.toISOString()}::timestamptz`;
  const { lastCallAt, suspendedAt } = schema.computerSessions;
  await tx
    .update(schema.computerSessions)
    .set({
      lastCallAt: sql`CASE WHEN ${lastCallAt} <= ${suspendedAt} THEN ${lastCallAt} + (${at} - ${suspendedAt}) ELSE greatest(${lastCallAt}, ${at}) END`,
      suspendedAt: null,
      handedBackAt: resumedAt,
    })
    .where(
      and(
        eq(schema.computerSessions.computerId, computer.id),
        isNull(schema.computerSessions.endedAt),
        isNotNull(schema.computerSessions.suspendedAt),
      ),
    );
  return { ...computer, ...cleared };
}
// Registers a call in flight (under the computer row lock). It holds control for its session until its
// deadline, budgetMs from now, so nobody takes over mid-call, and keeps other calls' ends from letting the computer pause.
async function beginCall(
  tx: Transaction,
  computer: Pick<ComputerRow, 'id' | 'callsInFlight'>,
  sessionId: number,
  now: Date,
  budgetMs = CALL_BUDGET_MS,
) {
  const id = randomUUID();
  const until = new Date(now.getTime() + budgetMs);
  await tx
    .update(schema.computers)
    .set({
      callsInFlight: Object.fromEntries([
        ...liveCalls(computer.callsInFlight, now),
        [id, { sessionId, until: until.toISOString() }],
      ]),
      lastUsedAt: now,
    })
    .where(eq(schema.computers.id, computer.id));
  await tx
    .update(schema.computerSessions)
    .set({
      lastCallAt: sql`greatest(${schema.computerSessions.lastCallAt}, ${until.toISOString()}::timestamptz)`,
    })
    .where(eq(schema.computerSessions.id, sessionId));
  return id;
}

type Call = { id: string; sessionId: number; computerId: number; member: Member };
// Tells the provider when to pause the computer: timeoutMs from now, or at once for 0.
type PauseAfter = (timeoutMs: number) => Promise<void>;
// What keeps a computer running, read under the computer row lock.
type Holds = Pick<ComputerRow, 'callsInFlight' | 'liveViewWatches' | 'takeoverUntil'>;
// When the computer may pause, the one rule every path that ends a call or a hold uses: the latest of each call in
// flight's deadline plus the idle minute, each live watch and the live takeover until it lapses (their lapse is
// their idle time), and the live session's idle minute while it holds control. `idle` adds an idle minute from
// now, for a call that just ended other than by a close. Now, with nothing left: pause at once.
function pauseAt(
  computer: Holds,
  session: (SessionClock & Pick<SessionRow, 'endedAt'>) | null,
  now: Date,
  idle = false,
) {
  const times = [now.getTime()];
  for (const [, call] of liveCalls(computer.callsInFlight, now)) times.push(Date.parse(call.until) + IDLE_PAUSE_MS);
  for (const [, until] of liveWatches(computer.liveViewWatches, now)) times.push(Date.parse(until));
  if (takenOver(computer, now)) times.push(computer.takeoverUntil!.getTime());
  if (session && !session.endedAt && holdsControl(session, now))
    times.push(session.lastCallAt.getTime() + IDLE_PAUSE_MS);
  if (idle) times.push(now.getTime() + IDLE_PAUSE_MS);
  return new Date(Math.max(...times));
}
// The computer's live session (at most one), locked; null without one.
async function liveSession(tx: Transaction, computerId: number) {
  const [live] = await tx
    .select()
    .from(schema.computerSessions)
    .where(and(eq(schema.computerSessions.computerId, computerId), isNull(schema.computerSessions.endedAt)))
    .for('update');
  return live ?? null;
}
// Has the provider pause the computer `until - now` from now (pauseAt), then meters to that. The computer row lock
// keeps a new call from connecting before the provider's new timeout lands; the provider bounds its request
// (the E2B adapter's setTimeout). It meters only once the provider took the time, so a failure keeps the earlier, later pause.
async function pauseComputer(
  tx: Transaction,
  metering: Metering,
  computerId: number,
  member: Member,
  until: Date,
  now: Date,
  pauseAfter: PauseAfter,
) {
  const timeoutMs = Math.max(0, until.getTime() - now.getTime());
  try {
    await pauseAfter(timeoutMs);
  } catch (error) {
    logError('computer pause timeout', error);
    return;
  }
  await meter(tx, metering, computerId, member, new Date(Date.now() + timeoutMs));
}
// Pausing without a connected session, for a hold that ended: setTimeout never wakes a paused computer.
const pauseByProvider =
  (provider: ComputerProvider, sandboxId: string): PauseAfter =>
  timeoutMs =>
    timeoutMs ? provider.setTimeout(sandboxId, timeoutMs) : provider.pause(sandboxId);
// The end of a call: other calls in flight, live-view holds, and the idle minute (none for a close) keep the
// computer running, by pauseAt. The session's lastCallAt becomes when its calls ended.
async function finishCall(
  db: Database,
  metering: Metering,
  call: Call,
  pauseAfter: PauseAfter | null,
  { close = false } = {},
) {
  return db.transaction(async tx => {
    const [computer] = await tx
      .select({
        callsInFlight: schema.computers.callsInFlight,
        liveViewWatches: schema.computers.liveViewWatches,
        takeoverUntil: schema.computers.takeoverUntil,
      })
      .from(schema.computers)
      .where(eq(schema.computers.id, call.computerId))
      .for('update');
    if (!computer) return;
    const now = new Date();
    const others = liveCalls(computer.callsInFlight, now).filter(([id]) => id !== call.id);
    const latest = (calls: typeof others) =>
      Math.max(now.getTime(), ...calls.map(([, entry]) => Date.parse(entry.until)));
    const callsInFlight = Object.fromEntries(others);
    await tx.update(schema.computers).set({ callsInFlight }).where(eq(schema.computers.id, call.computerId));
    await tx
      .update(schema.computerSessions)
      .set({ lastCallAt: new Date(latest(others.filter(([, entry]) => entry.sessionId === call.sessionId))) })
      .where(eq(schema.computerSessions.id, call.sessionId));
    if (!pauseAfter) return;
    const until = pauseAt({ ...computer, callsInFlight }, await liveSession(tx, call.computerId), now, !close);
    return pauseComputer(tx, metering, call.computerId, call.member, until, now, pauseAfter);
  });
}
// Meters and connects for the call's hold: its budget and the idle minute. The returned done() must run after the
// call's work.
async function startCall(
  db: Database,
  { provider, metering }: Computers,
  call: Call,
  sandboxId: string,
  holdMs = CALL_HOLD_MS,
) {
  let session: ComputerSession | null = null;
  let finished: Promise<void> | undefined;
  const done = () => {
    finished ??= finishCall(db, metering, call, session && (timeoutMs => session!.setTimeout(timeoutMs))).then(
      () => {},
      error => logError('computer call end', error),
    );
    return finished;
  };
  try {
    await meterRun(db, metering, call.computerId, call.member, holdMs);
    markToolStep('connect');
    session = await provider.connect(sandboxId, holdMs);
  } catch (error) {
    await done();
    throw error;
  }
  return { session, done };
}

// What computer_open hands back: the session, the fork it runs on, the profile it uses (null with none) among the
// member's profiles, and how that profile's latest capture applied.
export type OpenedSession = SessionHandle & {
  sync: SyncSummary;
  computer: { id: string; label: string | null; created: boolean };
  profile: Profile | null;
  profiles: Profile[];
};
type Started = {
  id: number;
  publicId: string;
  callId: string;
  computer: Pick<ComputerRow, 'id' | 'publicId' | 'label' | 'revision'>;
  sandboxId: string | null;
  created: boolean;
  userHadControl: boolean;
  profile: Profile | null;
};
// The profile a session asks for, and the member's profiles to choose from when it names none (pickProfile).
type ProfileChoice = { named: Profile | undefined; profiles: Profile[] };

const profileNotFound: ComputerFailure = {
  error: 'profile_not_found',
  message:
    'No such browser profile for this account: its browser may have signed out of Clutchbox, or been removed from this organization. Omit profile for the default, or pick one from the profiles computer_open and computer_list return.',
};

// Starts a computer session for the caller on a fork, on one of the member's profiles, applying its latest capture
// first. Without computerId it creates a new fork from the main computer's latest snapshot; with one of the member's
// forks' IDs it reopens that fork, as it does the fork of the caller's own session when given only that session's ID.
// `profile` names a profile by its browser's public ID; without it, the fork keeps the profile its last session used
// (pickProfile). A session holding control of the fork means `busy`, unless it is the caller's own live sessionId,
// which this replaces. Callers must already have verified the live MCP grant and pass a guard that re-checks it.
export async function openComputerSession(
  db: Database,
  computers: Computers,
  caller: Caller,
  {
    sessionId,
    computerId,
    label,
    profile,
  }: {
    sessionId?: string | undefined;
    computerId?: string | undefined;
    label?: string | undefined;
    profile?: string | undefined;
  } = {},
): Promise<OpenedSession | ComputerFailure> {
  const deadline = Date.now() + SYNC_DEADLINE_MS;
  const exhausted = await allowanceFailure(computers.metering, db, caller);
  if (exhausted) return exhausted;
  const profiles = await listProfiles(db, caller);
  const choice = { named: profiles.find(each => each.id === profile), profiles };
  if (profile !== undefined && !choice.named) return profileNotFound;
  const fork = computerId ?? (sessionId ? await forkOfSession(db, caller, sessionId) : null);
  const started = fork
    ? await reopenFork(db, caller, fork, sessionId, choice)
    : await createFork(db, computers, caller, label, choice);
  if ('error' in started) return started;
  const { computer } = started;
  const call = { id: started.callId, sessionId: started.id, computerId: computer.id, member: caller };
  let done: (() => Promise<void>) | undefined;
  try {
    const sandboxId = started.sandboxId ?? (await provisionFork(db, computers.provider, computer));
    const handle = await startCall(db, computers, call, sandboxId);
    done = handle.done;
    markToolStep('sync');
    // Before the apply, which needs the browser this may restart.
    await refreshComputer(db, computers.provider, computer, handle.session);
    const [sync] = await Promise.all([
      applyProfiles(db, caller, computer, handle.session, started.profile, profiles, deadline),
      applyTimeZone(db, computer.id, handle.session),
    ]);
    return {
      sessionId: started.publicId,
      session: handle.session,
      sync,
      computer: { id: computer.publicId, label: computer.label, created: started.created },
      profile: started.profile,
      profiles,
      done,
      ...(started.userHadControl ? { userHadControl: true } : {}),
    };
  } catch (error) {
    await done?.();
    // The caller never got this session's ID: end it, or it would hold control (busy) for the idle minute.
    await endSession(db, started.id, 'closed').catch(endError => logError('computer open cleanup', endError));
    throw error;
  }
}

// The fork of the caller's own computer session (live or not), so an agent passing only its session_id gets its fork
// back; null for a session on the main computer, from before forks.
async function forkOfSession(db: Database, caller: Caller, sessionId: string) {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  const [row] = await db
    .select({ publicId: schema.computers.publicId })
    .from(schema.computerSessions)
    .innerJoin(schema.computers, eq(schema.computers.id, schema.computerSessions.computerId))
    .where(and(eq(schema.computerSessions.publicId, sessionId), ownedBy(caller), isNotNull(schema.computers.forkOf)));
  return row?.publicId ?? null;
}

// Starts the caller's computer session on a ready computer, on its profile (pickProfile), under the computer's row lock:
// ends a lapsed takeover, and refuses while the user holds a takeover or another session holds control. The caller's
// own live session (sessionId) is replaced instead.
async function startSession(
  tx: Transaction,
  caller: Caller,
  locked: ComputerRow,
  sessionId: string | undefined,
  now: Date,
  choice: ProfileChoice,
): Promise<Omit<Started, 'computer' | 'sandboxId' | 'created'> | ComputerFailure> {
  let computer = locked;
  let live = await liveSession(tx, computer.id);
  if (lapsed(computer, now)) {
    computer = await endTakeover(tx, computer, now);
    live = await liveSession(tx, computer.id);
  }
  const own = !!live && !!sessionId && live.publicId === sessionId && isCallers(live, caller);
  // The user's takeover: the session it suspended waits for the hand-back; everyone else is busy until then.
  if (takenOver(computer, now)) return own && live?.suspendedAt ? userInControl : userBusy;
  if (live) {
    if (!own && holdsControl(live, now)) {
      const busyUntil = new Date(live.lastCallAt.getTime() + IDLE_PAUSE_MS);
      return {
        error: 'busy',
        busyUntil,
        message: `Another computer session is using this computer: another agent, or one of yours whose session_id was not passed. Try again after ${busyUntil.toISOString()}, when its idle minute ends, or call computer_open without computer_id for a computer of your own.`,
      };
    }
    await endSession(tx, live.id, expired(live, now) ? 'idle' : own ? 'replaced' : 'superseded', now);
  }
  const profile = await pickProfile(tx, computer.id, choice);
  const publicId = newPublicId('computerSession', now.getTime());
  const [{ id }] = (await tx
    .insert(schema.computerSessions)
    .values({
      publicId,
      membershipId: caller.membershipId,
      ...(caller.apiKeyId !== undefined ? { apiKeyId: caller.apiKeyId } : { clientId: caller.clientId }),
      computerId: computer.id,
      connectedBrowserId: profile?.browserId ?? null,
      createdAt: now,
      lastCallAt: now,
    })
    .returning({ id: schema.computerSessions.id })) as [{ id: number }];
  const callId = await beginCall(tx, computer, id, now);
  // Reopening its own session right after a hand-back: the new one's first result says the user had control.
  return { id, publicId, callId, userHadControl: own && !!live?.handedBackAt, profile };
}

// One call within the caller's live computer session: resumes the fork without applying, and, once after a hand-back,
// says that the user had control. budgetMs: how long the call may hold control, CALL_BUDGET_MS for a tool call's, or
// as long as the CDP proxy keeps its connection.
export async function useComputerSession(
  db: Database,
  computers: Computers,
  caller: Caller,
  sessionId: string,
  { budgetMs = CALL_BUDGET_MS }: { budgetMs?: number } = {},
): Promise<SessionHandle | ComputerFailure> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return notFound;
  const control = async (tx: Transaction) =>
    (await guardFailure(tx, caller)) ?? (await lockSession(tx, caller, sessionId, new Date()));
  const checked = await db.transaction(control);
  if ('error' in checked) return checked;
  const exhausted = await allowanceFailure(computers.metering, db, caller);
  if (exhausted) return exhausted;
  const started = await db.transaction(
    async (
      tx,
    ): Promise<
      { computer: ComputerRow; sessionKey: number; callId: string; handedBackAt: Date | null } | ComputerFailure
    > => {
      const locked = await control(tx);
      if ('error' in locked) return locked;
      const { computer, session } = locked;
      return {
        computer,
        sessionKey: session.id,
        callId: await beginCall(tx, computer, session.id, new Date(), budgetMs),
        handedBackAt: session.handedBackAt,
      };
    },
  );
  if ('error' in started) return started;
  const { computer, handedBackAt } = started;
  const call = { id: started.callId, sessionId: started.sessionKey, computerId: computer.id, member: caller };
  const { session, done } = await startCall(db, computers, call, computer.sandboxId!, budgetMs + IDLE_PAUSE_MS);
  try {
    // Cleared only once the call can run, so a failed one leaves the notice for the agent's retry; conditional, so
    // a newer hand-back since stays.
    if (handedBackAt)
      await db
        .update(schema.computerSessions)
        .set({ handedBackAt: null })
        .where(
          and(
            eq(schema.computerSessions.id, started.sessionKey),
            eq(schema.computerSessions.handedBackAt, handedBackAt),
          ),
        );
    return { sessionId, session, done, ...(handedBackAt ? { userHadControl: true } : {}) };
  } catch (error) {
    await done();
    throw error;
  }
}

// Ends the caller's computer session at once, so no later call can use it, and pauses its fork unless live view or a
// call still in flight holds it (pauseAt). The fork keeps its tabs and files for the next open. A session the user's
// takeover suspended is only ended. Then sweeps forks unused for a week (sweepForks), which a close can afford.
export async function closeComputerSession(
  db: Database,
  { provider, metering }: Computers,
  caller: Caller,
  sessionId: string,
): Promise<{ closed: true } | ComputerFailure> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return notFound;
  const closed = await db.transaction(async (tx): Promise<{ closed: true } | ComputerFailure> => {
    const denied = await guardFailure(tx, caller);
    if (denied) return denied;
    const now = new Date();
    const locked = await lockSession(tx, caller, sessionId, now, { close: true });
    if ('error' in locked) return locked;
    const { computer, session } = locked;
    await endSession(tx, session.id, 'closed', now);
    if (!session.suspendedAt && running(computer, now))
      await pauseComputer(
        tx,
        metering,
        computer.id,
        caller,
        pauseAt(computer, null, now),
        now,
        pauseByProvider(provider, computer.sandboxId!),
      );
    return { closed: true };
  });
  if ('closed' in closed) await sweepForks(db, provider).catch(error => logError('fork sweep', error));
  return closed;
}

// --- CDP ---
// A REST computer session's CDP URL carries a secret of its own, so frameworks that take only a URL (Playwright,
// browser-use, Stagehand) can connect, and the API key never appears in one. Only its SHA-256 is kept, and it works
// only while its session is open: the CDP proxy (packages/api/src/cdp.ts) finds the session by it, then acts as the
// session's caller, re-checking where the session stands as it runs (computerSessionState).
export const CDP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const cdpTokenHash = (token: string) => createHash('sha256').update(token).digest('base64url');

// A new CDP secret for the caller's own live session, replacing any earlier one; null without that session.
export async function issueCdpToken(db: Database, caller: Caller, sessionId: string): Promise<string | null> {
  const token = randomBytes(32).toString('base64url');
  const [issued] = await db
    .update(schema.computerSessions)
    .set({ cdpTokenHash: cdpTokenHash(token) })
    .where(
      and(eq(schema.computerSessions.publicId, sessionId), ownedBy(caller), isNull(schema.computerSessions.endedAt)),
    )
    .returning({ id: schema.computerSessions.id });
  return issued ? token : null;
}

// The session a CDP secret names, with the member and API key it belongs to; null for an unknown secret or an ended
// session.
export async function cdpSessionOf(db: Pick<Database, 'select'>, token: string) {
  if (!CDP_TOKEN_PATTERN.test(token)) return null;
  const [found] = await db
    .select({
      sessionId: schema.computerSessions.publicId,
      apiKeyId: schema.computerSessions.apiKeyId,
      userId: schema.memberships.userId,
      membershipId: schema.memberships.id,
      organizationId: schema.memberships.organizationId,
    })
    .from(schema.computerSessions)
    .innerJoin(schema.memberships, eq(schema.memberships.id, schema.computerSessions.membershipId))
    .where(and(eq(schema.computerSessions.cdpTokenHash, cdpTokenHash(token)), isNull(schema.computerSessions.endedAt)));
  if (!found?.apiKeyId) return null;
  const { sessionId, apiKeyId, ...member } = found;
  return { sessionId, apiKeyId, member };
}

// Where the caller's computer session stands, for the CDP proxy's re-checks and the REST API's session status: open
// while the caller's access holds (its guard) and the session is live; user_in_control while the user's takeover
// suspends it, until the hand-back; ended otherwise. Reads only: the computer service ends what has lapsed on the
// session's next call.
export type SessionState = 'open' | 'user_in_control' | 'ended';
export async function computerSessionState(
  db: Database,
  caller: Caller,
  sessionId: string,
  now = new Date(),
): Promise<SessionState> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return 'ended';
  if (caller.guard && !(await caller.guard(db))) return 'ended';
  const [found] = await db
    .select({
      endedAt: schema.computerSessions.endedAt,
      lastCallAt: schema.computerSessions.lastCallAt,
      suspendedAt: schema.computerSessions.suspendedAt,
      takeoverUntil: schema.computers.takeoverUntil,
    })
    .from(schema.computerSessions)
    .innerJoin(schema.computers, eq(schema.computers.id, schema.computerSessions.computerId))
    .where(and(eq(schema.computerSessions.publicId, sessionId), ownedBy(caller)));
  if (!found || found.endedAt) return 'ended';
  if (found.suspendedAt || takenOver(found, now)) return 'user_in_control';
  return expired(found, now) ? 'ended' : 'open';
}

// --- Forks ---
// Agents work in forks of the member's main computer, never in main. A fork is a computers row with fork_of set: a
// copy of main from one of its snapshots, with its own computer sessions, calls, metering, and applies like any
// computer. computer_open without an ID creates one; with its ID, any agent of the member reopens it, and forks unused
// for FORK_UNUSED_MS are deleted. Main is snapshotted when a fork needs it and it has no snapshot, or a takeover ended
// since its latest (latestSnapshot). The provider keeps a snapshot until every fork made from it is deleted, so a
// superseded snapshot is deleted once its last fork is (deleteUnusedSnapshots).

// Forks running at once across an organization's members, unless organizations.max_running_forks says otherwise. A
// judgment call: plenty for a team's parallel agents, and far below E2B's concurrency limits (100 on Pro).
export const DEFAULT_MAX_RUNNING_FORKS = 10;
// Expired forks, or unused snapshots, deleted per sweep: each is a provider request a computer_close waits on.
const SWEEP_BATCH = 3;

const forkNotFound: ComputerFailure = {
  error: 'computer_not_found',
  message:
    'No such computer for this account. Call computer_list for your computers, or computer_open without computer_id for a new one.',
};
// One of the member's forks by its public ID.
const forkOfMember = (member: Pick<Member, 'membershipId'>, computerId: string) =>
  and(
    eq(schema.computers.publicId, computerId),
    eq(schema.computers.membershipId, member.membershipId),
    isNotNull(schema.computers.forkOf),
  );

// A new fork from main's latest snapshot, with the caller's session on it, recorded as `creating` and running (for the
// cap and metering) until provisionFork creates its provider computer.
async function createFork(
  db: Database,
  computers: Computers,
  caller: Caller,
  label: string | undefined,
  choice: ProfileChoice,
): Promise<Started | ComputerFailure> {
  const main = await ensureComputer(db, computers, caller);
  if ('error' in main) return main;
  const latest = await latestSnapshot(db, computers, caller, main.id);
  if ('error' in latest) return latest;
  return db.transaction(async (tx): Promise<Started | ComputerFailure> => {
    const denied = await guardFailure(tx, caller);
    if (denied) return denied;
    const now = new Date();
    const full = await capFailure(tx, caller, now);
    if (full) return full;
    // Main's latest snapshot, read under main's row lock, so one superseded since is never used; the fork's reference
    // then keeps it from being deleted (deleteUnusedSnapshots).
    await tx
      .select({ id: schema.computers.id })
      .from(schema.computers)
      .where(eq(schema.computers.id, main.id))
      .for('share');
    const [current] = await tx
      .select({ snapshot: schema.computerSnapshots, mainPublicId: schema.computers.publicId })
      .from(schema.computers)
      .innerJoin(schema.computerSnapshots, eq(schema.computerSnapshots.id, schema.computers.snapshotId))
      .where(eq(schema.computers.id, main.id));
    if (!current) return resetting;
    const { snapshot } = current;
    const publicId = newPublicId('computer', now.getTime());
    const [fork] = await tx
      .insert(schema.computers)
      .values({
        publicId,
        membershipId: caller.membershipId,
        createdAt: now,
        forkOf: main.id,
        snapshotId: snapshot.id,
        label: label ?? null,
        lastUsedAt: now,
        timeZone: snapshot.timeZone,
        revision: snapshot.revision,
      })
      .returning(computerColumns);
    // What main's profiles had applied, so the first apply on the fork sends only what changed since.
    const inherited = await tx
      .select()
      .from(schema.computerProfiles)
      .where(eq(schema.computerProfiles.snapshotId, snapshot.id));
    if (inherited.length)
      await tx.insert(schema.computerProfiles).values(
        inherited.map(row => ({
          computerId: fork!.id,
          connectedBrowserId: row.connectedBrowserId,
          chromeProfile: row.chromeProfile,
          appliedCaptureDigest: row.appliedCaptureDigest,
          appliedCaptureAt: row.appliedCaptureAt,
          syncedSites: row.syncedSites,
          appliedCapture: resealBaseline(row.appliedCapture, caller, current.mainPublicId, publicId),
        })),
      );
    const started = await startSession(tx, caller, fork!, undefined, now, choice);
    if ('error' in started) return started;
    await meter(tx, computers.metering, fork!.id, caller, new Date(now.getTime() + CALL_HOLD_MS));
    return { ...started, computer: fork!, sandboxId: null, created: true };
  });
}
// The applied capture's baseline is sealed for one computer, so a fork gets main's sealed for it. One that cannot be
// opened gives none, so the fork's next apply replaces each site wholesale.
function resealBaseline(sealed: string | null, member: Owner, from: string, to: string) {
  if (!sealed) return null;
  try {
    return sealAppliedCapture(openAppliedCapture(sealed, member, from), member, to);
  } catch (error) {
    logError('applied capture', error);
    return null;
  }
}

// Creates a new fork's provider computer from its snapshot. A failure deletes the fork, and its provider computer if
// the create got that far, so nothing stays `creating`.
async function provisionFork(db: Database, provider: ComputerProvider, fork: Pick<ComputerRow, 'id' | 'publicId'>) {
  markToolStep('create');
  try {
    const [row] = await db
      .select({ snapshot: schema.computerSnapshots.providerSnapshotId })
      .from(schema.computers)
      .innerJoin(schema.computerSnapshots, eq(schema.computerSnapshots.id, schema.computers.snapshotId))
      .where(eq(schema.computers.id, fork.id));
    if (!row) throw new Error('fork snapshot missing');
    const sandboxId = await provider.createFromSnapshot(row.snapshot, fork.publicId, CALL_HOLD_MS);
    // Conditional: a membership removal may have deleted the fork meanwhile.
    const [ready] = await db
      .update(schema.computers)
      .set({ status: 'ready', sandboxId })
      .where(and(eq(schema.computers.id, fork.id), eq(schema.computers.status, 'creating')))
      .returning({ id: schema.computers.id });
    if (!ready) throw new Error('fork deleted while it was created');
    return sandboxId;
  } catch (error) {
    const created = await provider.find(fork.publicId).catch(() => null);
    if (created) await provider.kill(created).catch(killError => logError('fork create cleanup', killError));
    // Its computer session goes with it (cascade).
    await db
      .delete(schema.computers)
      .where(eq(schema.computers.id, fork.id))
      .catch(deleteError => logError('fork create cleanup', deleteError));
    throw error;
  }
}

// Reopens one of the caller's member's forks for a new computer session.
async function reopenFork(
  db: Database,
  caller: Caller,
  computerId: string,
  sessionId: string | undefined,
  choice: ProfileChoice,
): Promise<Started | ComputerFailure> {
  if (!COMPUTER_ID_PATTERN.test(computerId)) return forkNotFound;
  return db.transaction(async (tx): Promise<Started | ComputerFailure> => {
    const denied = await guardFailure(tx, caller);
    if (denied) return denied;
    const now = new Date();
    const cap = await lockForkCap(tx, caller);
    const [fork] = await tx
      .select(computerColumns)
      .from(schema.computers)
      .where(forkOfMember(caller, computerId))
      .for('update');
    if (!fork) return forkNotFound;
    if (fork.status !== 'ready' || !fork.sandboxId)
      return { error: 'starting', message: 'This computer is still being created. Try again in a few seconds.' };
    // One already running adds nothing to the organization's running forks.
    if (!running(fork, now)) {
      const full = await capFailure(tx, caller, now, cap);
      if (full) return full;
    }
    const started = await startSession(tx, caller, fork, sessionId, now, choice);
    if ('error' in started) return started;
    return { ...started, computer: fork, sandboxId: fork.sandboxId, created: false };
  });
}

// The organization's cap on running forks, under a lock that serializes opens across its members, so two cannot both
// take the last place. Taken after the user row and before any computer row.
async function lockForkCap(tx: Transaction, member: Member) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('agent-computers-forks'), hashtext(${member.organizationId}))`,
  );
  const [organization] = await tx
    .select({ max: schema.organizations.maxRunningForks })
    .from(schema.organizations)
    .where(eq(schema.organizations.publicId, member.organizationId));
  return organization?.max ?? DEFAULT_MAX_RUNNING_FORKS;
}
// busy once the organization's running forks (not yet paused, or being created) reach its cap, until the first of
// them is due to pause.
async function capFailure(
  tx: Transaction,
  member: Member,
  now: Date,
  locked?: number,
): Promise<ComputerFailure | null> {
  const cap = locked ?? (await lockForkCap(tx, member));
  const forks = await tx
    .select({ runsUntil: schema.computers.runsUntil })
    .from(schema.computers)
    .innerJoin(schema.memberships, eq(schema.memberships.id, schema.computers.membershipId))
    .where(
      and(
        eq(schema.memberships.organizationId, member.organizationId),
        isNotNull(schema.computers.forkOf),
        or(gt(schema.computers.runsUntil, now), eq(schema.computers.status, 'creating')),
      ),
    );
  if (forks.length < cap) return null;
  const pauses = forks.flatMap(fork => (fork.runsUntil ? [fork.runsUntil.getTime()] : []));
  if (!pauses.length)
    return {
      error: 'busy',
      message: 'Your organization allows no computers to run. Ask its owner to raise the limit.',
    };
  const busyUntil = new Date(Math.min(...pauses));
  return {
    error: 'busy',
    busyUntil,
    message: `All ${cap} computers your organization may run at once are running. Try again after ${busyUntil.toISOString()}, when the first is due to pause.`,
  };
}

// Main's latest snapshot, which new forks start from: a new one first when main has none, or a takeover ended since
// (snapshotDueAt, or a lapsed takeover not yet ended), so the next fork has what the member signed in to. Taken under
// main's row lock, so concurrent opens take one, and never during a takeover, whose connections it would drop. Main is
// paused right after unless live view holds it. A failure keeps the previous snapshot, and the next fork retries;
// without one, the open fails.
async function latestSnapshot(
  db: Database,
  { provider, metering }: Computers,
  member: Member,
  mainId: number,
): Promise<{ id: number } | ComputerFailure> {
  let superseded: number | null = null;
  const latest = await db.transaction(async (tx): Promise<{ id: number } | ComputerFailure> => {
    let [main] = await tx.select().from(schema.computers).where(eq(schema.computers.id, mainId)).for('update');
    if (main?.status !== 'ready' || !main.sandboxId) return resetting;
    const { sandboxId } = main;
    const now = new Date();
    const due = !main.snapshotId || !!main.snapshotDueAt || lapsed(main, now);
    if (lapsed(main, now)) main = await endTakeover(tx, main, now);
    if (main.snapshotId && (!due || takenOver(main, now))) return { id: main.snapshotId };
    if (takenOver(main, now)) return userBusy;
    let providerSnapshotId: string;
    try {
      // Metered first, like a call: a paused main is resumed for the snapshot. Live view may hold it longer.
      const hold = new Date(now.getTime() + SNAPSHOT_HOLD_MS);
      const held = pauseAt(main, null, now);
      await meter(tx, metering, main.id, member, held > hold ? held : hold);
      markToolStep('snapshot');
      providerSnapshotId = await provider.snapshot(sandboxId, SNAPSHOT_HOLD_MS);
    } catch (error) {
      if (!main.snapshotId) throw error;
      logError('computer snapshot', error);
      return { id: main.snapshotId };
    }
    const [snapshot] = await tx
      .insert(schema.computerSnapshots)
      .values({ computerId: main.id, providerSnapshotId, timeZone: main.timeZone, revision: main.revision })
      .returning({ id: schema.computerSnapshots.id });
    // Main's profiles as it has them, baselines sealed for main as they are.
    const profiles = await tx
      .select()
      .from(schema.computerProfiles)
      .where(eq(schema.computerProfiles.computerId, main.id));
    if (profiles.length)
      await tx.insert(schema.computerProfiles).values(
        profiles.map(({ id: _id, computerId: _main, createdAt: _created, updatedAt: _updated, ...row }) => ({
          ...row,
          snapshotId: snapshot!.id,
        })),
      );
    await tx
      .update(schema.computers)
      .set({ snapshotId: snapshot!.id, snapshotDueAt: null })
      .where(eq(schema.computers.id, main.id));
    superseded = main.snapshotId;
    const after = new Date();
    await pauseComputer(
      tx,
      metering,
      main.id,
      member,
      pauseAt(main, null, after),
      after,
      pauseByProvider(provider, sandboxId),
    );
    return { id: snapshot!.id };
  });
  if (superseded) await deleteUnusedSnapshots(db, provider, [superseded]);
  return latest;
}

// Snapshots that are no longer main's latest and that no fork was made from, at most SWEEP_BATCH of them (only these
// IDs, when given): deleted at the provider, which refuses earlier, then here. Each is re-checked under its row lock,
// which a fork's insert referencing it waits on, so a fork never starts from a deleted snapshot.
async function deleteUnusedSnapshots(db: Database, provider: ComputerProvider, only?: number[]) {
  const unused = sql`NOT EXISTS (SELECT 1 FROM ${schema.computers} WHERE ${schema.computers.snapshotId} = ${schema.computerSnapshots.id})`;
  const candidates = await db
    .select({ id: schema.computerSnapshots.id })
    .from(schema.computerSnapshots)
    .where(and(unused, only ? inArray(schema.computerSnapshots.id, only) : undefined))
    .limit(SWEEP_BATCH);
  for (const { id } of candidates)
    await db
      .transaction(async tx => {
        const [row] = await tx
          .select({ providerSnapshotId: schema.computerSnapshots.providerSnapshotId })
          .from(schema.computerSnapshots)
          .where(and(eq(schema.computerSnapshots.id, id), unused))
          .for('update');
        if (!row) return;
        await provider.deleteSnapshot(row.providerSnapshotId);
        await tx.delete(schema.computerSnapshots).where(eq(schema.computerSnapshots.id, id));
      })
      .catch(error => logError('snapshot delete', error));
}

export type ForkView = {
  computerId: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string;
  // in_use: a computer session holds control, or the user took it over in live view.
  status: 'starting' | 'in_use' | 'running' | 'paused';
  // The agent whose computer session is open on it, suspended by a takeover or not; null with none. host: where an MCP
  // client's ID points, or an API key's name.
  agent: { agent: AgentKind | null; host: string } | null;
};
// The member's forks, most recently used first.
export async function listForks(db: Database, member: Member, now = new Date()): Promise<ForkView[]> {
  const forks = await db
    .select({
      id: schema.computers.id,
      publicId: schema.computers.publicId,
      label: schema.computers.label,
      status: schema.computers.status,
      createdAt: schema.computers.createdAt,
      lastUsedAt: schema.computers.lastUsedAt,
      runsUntil: schema.computers.runsUntil,
      takeoverUntil: schema.computers.takeoverUntil,
    })
    .from(schema.computers)
    .where(and(eq(schema.computers.membershipId, member.membershipId), isNotNull(schema.computers.forkOf)))
    .orderBy(desc(schema.computers.lastUsedAt));
  const live = forks.length
    ? await db
        .select({
          computerId: schema.computerSessions.computerId,
          clientId: schema.computerSessions.clientId,
          keyName: schema.apikey.name,
          lastCallAt: schema.computerSessions.lastCallAt,
          suspendedAt: schema.computerSessions.suspendedAt,
        })
        .from(schema.computerSessions)
        .leftJoin(schema.apikey, eq(schema.apikey.id, schema.computerSessions.apiKeyId))
        .where(
          and(
            inArray(
              schema.computerSessions.computerId,
              forks.map(fork => fork.id),
            ),
            isNull(schema.computerSessions.endedAt),
          ),
        )
    : [];
  const controlled = new Set(live.filter(session => holdsControl(session, now)).map(session => session.computerId));
  const agents = new Map(
    live
      .filter(session => !expired(session, now))
      .map(({ computerId, clientId, keyName }) => [
        computerId,
        clientId
          ? { agent: agentOf(clientId), host: clientHost(clientId) ?? clientId }
          : { agent: null, host: `${keyName ?? 'An'} API key` },
      ]),
  );
  return forks.map(fork => ({
    computerId: fork.publicId,
    label: fork.label,
    createdAt: fork.createdAt.toISOString(),
    lastUsedAt: (fork.lastUsedAt ?? fork.createdAt).toISOString(),
    status:
      fork.status === 'creating'
        ? 'starting'
        : controlled.has(fork.id) || takenOver(fork, now)
          ? 'in_use'
          : running(fork, now)
            ? 'running'
            : 'paused',
    agent: agents.get(fork.id) ?? null,
  }));
}

// Deletes one of the member's forks, with what was on it. Another agent's session holding control of it, or the user's
// takeover, means `busy`; the caller's own agent's session just ends.
export async function deleteFork(
  db: Database,
  { provider }: Computers,
  caller: Caller,
  computerId: string,
): Promise<{ deleted: true } | ComputerFailure> {
  if (!COMPUTER_ID_PATTERN.test(computerId)) return forkNotFound;
  const found = await db.transaction(async (tx): Promise<ComputerRow | ComputerFailure> => {
    const denied = await guardFailure(tx, caller);
    if (denied) return denied;
    const [fork] = await tx
      .select(computerColumns)
      .from(schema.computers)
      .where(forkOfMember(caller, computerId))
      .for('update');
    if (!fork) return forkNotFound;
    const now = new Date();
    if (takenOver(fork, now)) return userBusy;
    const live = await liveSession(tx, fork.id);
    if (live && holdsControl(live, now) && !isCallers(live, caller)) {
      const busyUntil = new Date(live.lastCallAt.getTime() + IDLE_PAUSE_MS);
      return {
        error: 'busy',
        busyUntil,
        message: `Another agent is using this computer. Try again after ${busyUntil.toISOString()}, when its idle minute ends.`,
      };
    }
    if (live) await endSession(tx, live.id, 'closed', now);
    return fork;
  });
  if ('error' in found) return found;
  await destroyFork(db, provider, found);
  await sweepForks(db, provider).catch(error => logError('fork sweep', error));
  return { deleted: true };
}
// Kills a fork's provider computer, recorded or not, then forgets the fork (its sessions go with it) and deletes its
// snapshot if nothing else uses it. A failed kill keeps the row, for a retry.
async function destroyFork(
  db: Database,
  provider: ComputerProvider,
  fork: Pick<ComputerRow, 'id' | 'publicId' | 'sandboxId' | 'snapshotId'>,
) {
  await killFork(provider, fork);
  await db.delete(schema.computers).where(eq(schema.computers.id, fork.id));
  if (fork.snapshotId) await deleteUnusedSnapshots(db, provider, [fork.snapshotId]);
}
const killFork = async (provider: ComputerProvider, fork: Pick<ComputerRow, 'publicId' | 'sandboxId'>) => {
  for (const sandboxId of new Set([fork.sandboxId, await provider.find(fork.publicId)]))
    if (sandboxId) await provider.kill(sandboxId);
};

// Deletes, across the deployment, forks unused for FORK_UNUSED_MS and paused, and forks whose create was abandoned
// (CREATE_STALE_MS), then snapshots nothing uses, SWEEP_BATCH of each per run. The open core has no scheduler, so this
// runs on the calls that can afford it, computer_close and computer_delete, as tool call retention runs on each call.
export async function sweepForks(db: Database, provider: ComputerProvider, now = new Date()) {
  const due = and(
    isNotNull(schema.computers.forkOf),
    or(
      and(
        eq(schema.computers.status, 'ready'),
        lt(schema.computers.lastUsedAt, new Date(now.getTime() - FORK_UNUSED_MS)),
        or(isNull(schema.computers.runsUntil), lt(schema.computers.runsUntil, now)),
      ),
      and(
        eq(schema.computers.status, 'creating'),
        lt(schema.computers.updatedAt, new Date(now.getTime() - CREATE_STALE_MS)),
      ),
    ),
  );
  const expired = await db.select({ id: schema.computers.id }).from(schema.computers).where(due).limit(SWEEP_BATCH);
  for (const { id } of expired)
    await db
      .transaction(async tx => {
        // Re-checked under the row lock, so a reopen that just used it keeps it.
        const [fork] = await tx
          .select(computerColumns)
          .from(schema.computers)
          .where(and(eq(schema.computers.id, id), due))
          .for('update');
        if (!fork) return;
        await killFork(provider, fork);
        await tx.delete(schema.computers).where(eq(schema.computers.id, id));
      })
      .catch(error => logError('fork expiry', error));
  await deleteUnusedSnapshots(db, provider);
}

// Kills every provider computer of a member's that is going away (main and forks), then their snapshots, which the
// provider deletes only once no computer made from them remains. Recorded or not: a create in flight is found by its ID.
export async function destroyProviderComputers(
  provider: ComputerProvider,
  computers: { publicId: string; sandboxId: string | null }[],
  snapshotIds: string[],
) {
  for (const computer of computers)
    for (const sandboxId of new Set([computer.sandboxId, await provider.find(computer.publicId)]))
      if (sandboxId) await provider.kill(sandboxId);
  for (const snapshotId of snapshotIds)
    await provider.deleteSnapshot(snapshotId).catch(error => logError('snapshot delete', error));
}

// --- Profiles ---
// Each profile (captures.ts, Profiles) has a Chrome profile of its own on every computer of the member's it was used on
// (computer_profiles): the computer's first gets FIRST_PROFILE, the directory Chrome already ran, so a computer only one
// browser syncs to never restarts Chrome for it, and each later one a directory named by its browser's public ID, which
// no other browser ever gets. A computer runs one profile at a time, its session's; a fork starts with main's profiles
// as its snapshot had them. A browser that stops syncing keeps its row: the next open on each computer signs its
// profile out of the sites it synced (applyProfiles), and its directory stays its own.

// The profile a new session on the computer uses: the one named, else the one the computer's last session used while
// it is still a profile, so a fork reopens as it was left, else the default, the profile synced last; null with none.
async function pickProfile(tx: Pick<Database, 'select'>, computerId: number, { named, profiles }: ProfileChoice) {
  if (named) return named;
  const [last] = await tx
    .select({ browser: schema.computerSessions.connectedBrowserId })
    .from(schema.computerSessions)
    .where(eq(schema.computerSessions.computerId, computerId))
    .orderBy(desc(schema.computerSessions.id))
    .limit(1);
  return profiles.find(each => each.browserId === last?.browser) ?? profiles[0] ?? null;
}

// Every computer_profiles column but the sealed baseline, which only an apply that needs it reads.
const { appliedCapture: _profileBaseline, ...profileColumns } = getTableColumns(schema.computerProfiles);
type ProfileRow = Omit<typeof schema.computerProfiles.$inferSelect, 'appliedCapture'>;

// The computer's row for a profile, made when the profile first runs there: FIRST_PROFILE's directory while no profile
// has it, else one named by the browser. Two opens racing for FIRST_PROFILE get one each.
async function profileRow(db: Database, computerId: number, profile: Profile, rows: ProfileRow[]) {
  const mine = () =>
    db
      .select(profileColumns)
      .from(schema.computerProfiles)
      .where(
        and(
          eq(schema.computerProfiles.computerId, computerId),
          eq(schema.computerProfiles.connectedBrowserId, profile.browserId),
        ),
      );
  const found = rows.find(row => row.connectedBrowserId === profile.browserId);
  if (found) return found;
  for (const chromeProfile of rows.some(row => row.chromeProfile === FIRST_PROFILE)
    ? [profile.id]
    : [FIRST_PROFILE, profile.id]) {
    await db
      .insert(schema.computerProfiles)
      .values({ computerId, connectedBrowserId: profile.browserId, chromeProfile })
      .onConflictDoNothing();
    const [row] = await mine();
    if (row) return row;
  }
  throw new Error('profile row missing');
}

// Runs the computer's Chrome on a profile, within what is left of the open's deadline. Throws when it could not: what
// runs then is unknown, and a session must never get another profile's sign-ins.
async function switchProfile(session: ComputerSession, chromeProfile: string, deadline: number) {
  const budget = Math.min(PROFILE_SWITCH_BUDGET_MS, deadline - Date.now());
  if (budget <= 0) throw new Error('no time left to switch profiles');
  await withinBudget(session.useProfile(chromeProfile, budget), budget + SYNC_SLACK_MS);
}

// At a session's start, with the computer's Chrome on its profile (or FIRST_PROFILE without one): first each profile of a
// browser that stopped syncing is signed out of what it synced, each in its own Chrome; then the session's profile gets
// its browser's latest capture. The summary is that apply's, or without a profile, the sign-outs'.
async function applyProfiles(
  db: Database,
  member: Owner,
  computer: Pick<ComputerRow, 'id' | 'publicId'>,
  session: ComputerSession,
  profile: Profile | null,
  profiles: Profile[],
  deadline: number,
): Promise<SyncSummary> {
  const rows = await db
    .select(profileColumns)
    .from(schema.computerProfiles)
    .where(eq(schema.computerProfiles.computerId, computer.id));
  const current = new Set(profiles.map(each => each.browserId));
  const signedOut: SyncSummary[] = [];
  for (const row of rows.filter(each => !current.has(each.connectedBrowserId) && each.syncedSites.length)) {
    try {
      await switchProfile(session, row.chromeProfile, deadline);
    } catch (error) {
      logError('profile switch', error);
      signedOut.push({ status: 'failed', sites: row.syncedSites });
      continue;
    }
    signedOut.push(await clearSyncedSites(db, row, session, deadline));
  }
  if (!profile) {
    await switchProfile(session, FIRST_PROFILE, deadline);
    if (!signedOut.length) return { status: 'none' };
    const sites = [...new Set(signedOut.flatMap(each => each.sites ?? []))].sort();
    return { status: signedOut.some(each => each.status === 'failed') ? 'failed' : 'cleared', sites };
  }
  const row = await profileRow(db, computer.id, profile, rows);
  await switchProfile(session, row.chromeProfile, deadline);
  return applyLatestCapture(db, member, computer, row, profile.browserId, session, deadline);
}
// Live view's apply, on a computer no agent is working on: to the profile a session there would get (pickProfile).
async function applyForLiveView(
  db: Database,
  member: Owner,
  computer: Pick<ComputerRow, 'id' | 'publicId'>,
  session: ComputerSession,
  deadline: number,
) {
  const profiles = await listProfiles(db, member);
  const profile = await pickProfile(db, computer.id, { named: undefined, profiles });
  return applyProfiles(db, member, computer, session, profile, profiles, deadline);
}

// The last applied capture's cookies; null without one or when it cannot be opened (the next apply is wholesale).
function baselineOf(sealed: string | null, member: Owner, computerId: string) {
  if (!sealed) return null;
  try {
    return openAppliedCapture(sealed, member, computerId).cookies;
  } catch (error) {
    logError('applied capture', error);
    return null;
  }
}
const withinBudget = <T>(work: Promise<T>, ms: number): Promise<T> => {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('sync budget exceeded')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
const textArray = (values: string[]) =>
  sql`array[${sql.join(
    values.map(value => sql`${value}`),
    sql`, `,
  )}]::text[]`;
const unionSites = (sites: string[]) =>
  sql`array(select distinct unnest(${schema.computerProfiles.syncedSites} || ${textArray(sites)}))`;
const sameBaseline = (row: Pick<ProfileRow, 'id' | 'appliedCaptureDigest'>) =>
  and(
    eq(schema.computerProfiles.id, row.id),
    sql`${schema.computerProfiles.appliedCaptureDigest} IS NOT DISTINCT FROM ${row.appliedCaptureDigest}`,
  );

// Apply at a computer session's start, to the profile Chrome runs: only cookies the browser added, changed, or deleted
// since the profile's last applied capture (cookieChanges), so the browser wins what it changed and the computer keeps
// the rest. Without a baseline each target site is replaced wholesale. A failure never blocks the open or close.
async function applyLatestCapture(
  db: Database,
  member: Owner,
  computer: Pick<ComputerRow, 'publicId'>,
  profile: Pick<ProfileRow, 'id' | 'chromeProfile'>,
  browser: number,
  session: ComputerSession,
  deadline: number,
): Promise<SyncSummary> {
  const [[row], latest] = await Promise.all([
    db.select().from(schema.computerProfiles).where(eq(schema.computerProfiles.id, profile.id)),
    latestCaptureDigest(db, member, browser),
  ]);
  if (!row) return { status: 'none' };
  if (!latest) return await clearSyncedSites(db, row, session, deadline);
  if (latest.digest === row.appliedCaptureDigest)
    return { status: 'unchanged', captureCompletedAt: latest.completedAt };
  let targetSites: string[] | undefined;
  try {
    const budget = Math.min(SYNC_BUDGET_MS, deadline - Date.now() - SYNC_SLACK_MS);
    if (budget < SYNC_MIN_MS) throw new Error('no time left');
    const loaded = await loadLatestCapture(db, member, browser);
    if (!loaded) return await clearSyncedSites(db, row, session, deadline);
    const changes = cookieChanges(
      baselineOf(row.appliedCapture, member, computer.publicId),
      loaded.capture.cookies,
      row.syncedSites,
      loaded.completedAt,
    );
    const sites = new Set([
      ...changes.clearSites,
      ...changes.set.map(siteOfCookie),
      ...changes.remove.map(siteOfCookie),
    ]);
    const next = [...new Set(loaded.capture.cookies.map(siteOfCookie))].sort();
    if (sites.size) {
      targetSites = next;
      await withinBudget(
        session.syncCookies({
          profile: row.chromeProfile,
          clearSites: changes.clearSites,
          cookies: [...changes.set.map(toCdpCookie), ...changes.remove.map(expiredCdpCookie)],
          budgetMs: budget,
        }),
        budget + SYNC_SLACK_MS,
      );
    }
    // Conditional on the state read above: a concurrent apply may have won.
    const [updated] = await db
      .update(schema.computerProfiles)
      .set({
        appliedCaptureDigest: loaded.digest,
        appliedCaptureAt: new Date(loaded.completedAt),
        syncedSites: next,
        appliedCapture: sealAppliedCapture(
          { completedAt: loaded.completedAt, cookies: loaded.capture.cookies },
          member,
          computer.publicId,
        ),
        updatedAt: new Date(),
      })
      .where(sameBaseline(row))
      .returning({ id: schema.computerProfiles.id });
    if (!updated) {
      // Unless the winner applied this same capture, keep both site sets and re-apply wholesale next time.
      await db
        .update(schema.computerProfiles)
        .set({ appliedCaptureDigest: null, appliedCapture: null, syncedSites: unionSites(next) })
        .where(
          and(
            eq(schema.computerProfiles.id, row.id),
            sql`${schema.computerProfiles.appliedCaptureDigest} IS DISTINCT FROM ${loaded.digest}`,
          ),
        );
    }
    return { status: 'applied', captureCompletedAt: loaded.completedAt, sitesUpdated: sites.size };
  } catch {
    console.error('Browser sync could not be applied to the computer; the next open retries.');
    // A cookie write may have been cut short: the computer no longer matches the baseline.
    if (targetSites)
      await db
        .update(schema.computerProfiles)
        .set({ appliedCapture: null, syncedSites: unionSites(targetSites) })
        .where(eq(schema.computerProfiles.id, row.id))
        .catch(error => logError('sync baseline reset', error));
    return { status: 'failed', captureCompletedAt: latest.completedAt };
  }
}

// With no capture for the profile (its browser signed out, or was removed from the organization, the organization
// turned sync off, or the uploads were deleted), the profile Chrome runs is signed out of every site it had synced,
// which would otherwise stay signed in for as long as the computer lives. Sites it never synced keep their sign-ins.
async function clearSyncedSites(
  db: Database,
  profile: Pick<ProfileRow, 'id' | 'chromeProfile' | 'syncedSites' | 'appliedCaptureDigest'>,
  session: ComputerSession,
  deadline: number,
): Promise<SyncSummary> {
  const sites = profile.syncedSites;
  if (!sites.length) return { status: 'none' };
  try {
    const budget = Math.min(SYNC_BUDGET_MS, deadline - Date.now() - SYNC_SLACK_MS);
    if (budget < SYNC_MIN_MS) throw new Error('no time left');
    await withinBudget(
      session.syncCookies({ profile: profile.chromeProfile, clearSites: sites, cookies: [], budgetMs: budget }),
      budget + SYNC_SLACK_MS,
    );
    // Unless a concurrent apply of a new capture won, whose sites this may have cleared: it re-applies wholesale next.
    const [updated] = await db
      .update(schema.computerProfiles)
      .set({
        syncedSites: sql`array(select unnest(${schema.computerProfiles.syncedSites}) except select unnest(${textArray(sites)}))`,
        updatedAt: new Date(),
      })
      .where(sameBaseline(profile))
      .returning({ id: schema.computerProfiles.id });
    if (!updated)
      await db
        .update(schema.computerProfiles)
        .set({ appliedCaptureDigest: null, appliedCapture: null })
        .where(eq(schema.computerProfiles.id, profile.id));
    return { status: 'cleared', sites };
  } catch {
    console.error('Synced sites could not be signed out on the computer; the next open retries.');
    return { status: 'failed', sites };
  }
}

// Existing computers never get a new template (rebuilding one would lose what is on it), so a computer behind the
// provider's revision gets its helpers and browser setup brought current here: on computer_open, before control is
// handed over, never during a computer session. A failure never blocks the open; the next one retries.
async function refreshComputer(
  db: Database,
  provider: ComputerProvider,
  computer: Pick<ComputerRow, 'id' | 'revision'>,
  session: ComputerSession,
) {
  if (computer.revision === provider.revision) return;
  try {
    await withinBudget(session.refresh(REFRESH_BUDGET_MS), REFRESH_BUDGET_MS + SYNC_SLACK_MS);
    await db.update(schema.computers).set({ revision: provider.revision }).where(eq(schema.computers.id, computer.id));
  } catch (error) {
    logError('computer refresh', error);
  }
}

// The user's browser time zone (time-zones.ts) as the computer's system zone, set only when it changed. Without
// a reported zone the computer keeps the template's UTC. A failure never blocks the open; the next one retries.
async function applyTimeZone(db: Database, computerId: number, session: ComputerSession) {
  try {
    const [row] = await db
      .select({ wanted: schema.userSettings.timeZone, applied: schema.computers.timeZone })
      .from(schema.computers)
      .innerJoin(schema.memberships, eq(schema.memberships.id, schema.computers.membershipId))
      .leftJoin(schema.userSettings, eq(schema.userSettings.userId, schema.memberships.userId))
      .where(eq(schema.computers.id, computerId));
    if (!row?.wanted || row.wanted === row.applied) return;
    await session.setTimeZone(row.wanted);
    await db.update(schema.computers).set({ timeZone: row.wanted }).where(eq(schema.computers.id, computerId));
  } catch (error) {
    logError('time zone', error);
  }
}

// --- Live view ---
// A lease is one load of the /computer page (a client-generated UUID). While visible, the page's heartbeat keeps a
// watch on the computer for its lease, and a takeover belongs to the lease that took it. Holds keep the computer
// running to their lapse deadline like calls in flight (pauseAt), and are metered as they are; they are extended only
// once less than HOLD_LAPSE_MS is left, and not at all once the allowance is used up, so they lapse.

export const LEASE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type LiveViewStatus = {
  computer: 'none' | 'paused' | 'running';
  // This lease holds a live watch.
  watching: boolean;
  // The live takeover, if any: whether this lease holds it, and since when.
  takeover: { mine: boolean; since: string } | null;
  // During a takeover, the agent whose computer session it suspended, once that agent got user_in_control: named
  // like the account page names grants (agents.ts), and since its first such call.
  agentWaiting: { agent: AgentKind | null; host: string; since: string } | null;
  allowanceExhausted?: { resetsAt: string } | undefined;
};
type LiveViewComputer = Pick<
  ComputerRow,
  | 'id'
  | 'publicId'
  | 'forkOf'
  | 'status'
  | 'sandboxId'
  | 'runsUntil'
  | 'callsInFlight'
  | 'liveViewWatches'
  | 'takeoverLease'
  | 'takenOverAt'
  | 'takeoverUntil'
>;
const liveViewColumns = {
  id: schema.computers.id,
  publicId: schema.computers.publicId,
  forkOf: schema.computers.forkOf,
  status: schema.computers.status,
  sandboxId: schema.computers.sandboxId,
  runsUntil: schema.computers.runsUntil,
  callsInFlight: schema.computers.callsInFlight,
  liveViewWatches: schema.computers.liveViewWatches,
  takeoverLease: schema.computers.takeoverLease,
  takenOverAt: schema.computers.takenOverAt,
  takeoverUntil: schema.computers.takeoverUntil,
};
// Which of the member's computers live view acts on: main, or one of their forks by its ID.
export type LiveViewTarget = { computerId?: string | undefined };
const targetOf = (member: Member, { computerId }: LiveViewTarget) =>
  computerId ? forkOfMember(member, computerId) : mainOf(member);
const readyTarget = (member: Member, target: LiveViewTarget) =>
  and(targetOf(member, target), eq(schema.computers.status, 'ready'));
// The member's ready computer, locked, with a lapsed takeover ended; null without one.
async function lockLiveView(
  tx: Transaction,
  member: Member,
  now: Date,
  target: LiveViewTarget,
): Promise<LiveViewComputer | null> {
  const [computer] = await tx
    .select(liveViewColumns)
    .from(schema.computers)
    .where(readyTarget(member, target))
    .for('update');
  if (!computer?.sandboxId) return null;
  return lapsed(computer, now) ? endTakeover(tx, computer, now) : computer;
}
const mine = (computer: Pick<ComputerRow, 'takeoverLease' | 'takeoverUntil'>, lease: string, now: Date) =>
  takenOver(computer, now) && computer.takeoverLease === lease;
// Writes changed holds and lets the computer pause when they no longer keep it running.
async function shortenHolds(
  tx: Transaction,
  { provider, metering }: Computers,
  member: Member,
  computer: LiveViewComputer,
  next: Pick<LiveViewComputer, 'liveViewWatches' | 'takeoverUntil'>,
  now: Date,
) {
  await tx
    .update(schema.computers)
    .set({
      liveViewWatches: next.liveViewWatches,
      ...(next.takeoverUntil && computer.takeoverUntil ? { takeoverUntil: next.takeoverUntil } : {}),
    })
    .where(eq(schema.computers.id, computer.id));
  if (!running(computer, now)) return;
  const until = pauseAt({ ...computer, ...next }, await liveSession(tx, computer.id), now);
  await pauseComputer(tx, metering, computer.id, member, until, now, pauseByProvider(provider, computer.sandboxId!));
}

// The page's view of live view for one lease. Reads only: a lapsed takeover counts as ended.
export async function liveViewStatus(
  db: Database,
  metering: Metering,
  member: Member,
  lease: string,
  now = new Date(),
  target: LiveViewTarget = {},
): Promise<LiveViewStatus> {
  const [[computer], refusal] = await Promise.all([
    db.select(liveViewColumns).from(schema.computers).where(targetOf(member, target)),
    metering.refusal(db, member, now),
  ]);
  const exhausted = refusal ? { allowanceExhausted: { resetsAt: refusal.resetsAt.toISOString() } } : {};
  if (computer?.status !== 'ready' || !computer.sandboxId)
    return { computer: 'none', watching: false, takeover: null, agentWaiting: null, ...exhausted };
  const takeover = takenOver(computer, now)
    ? { mine: computer.takeoverLease === lease, since: computer.takenOverAt!.toISOString() }
    : null;
  let agentWaiting: LiveViewStatus['agentWaiting'] = null;
  if (takeover) {
    const [waiting] = await db
      .select({ clientId: schema.computerSessions.clientId, since: min(schema.toolCalls.startedAt) })
      .from(schema.computerSessions)
      .innerJoin(
        schema.toolCalls,
        and(
          eq(schema.toolCalls.computerSessionId, schema.computerSessions.id),
          eq(schema.toolCalls.error, 'user_in_control'),
          gte(schema.toolCalls.startedAt, schema.computerSessions.suspendedAt),
        ),
      )
      .where(
        and(
          eq(schema.computerSessions.computerId, computer.id),
          isNull(schema.computerSessions.endedAt),
          isNotNull(schema.computerSessions.suspendedAt),
        ),
      )
      .groupBy(schema.computerSessions.clientId);
    // Only MCP calls are recorded, so only an MCP client is seen waiting.
    if (waiting?.since && waiting.clientId)
      agentWaiting = {
        agent: agentOf(waiting.clientId),
        host: clientHost(waiting.clientId) ?? waiting.clientId,
        since: waiting.since.toISOString(),
      };
  }
  return {
    computer: running(computer, now) ? 'running' : 'paused',
    watching: liveWatches(computer.liveViewWatches, now).some(([id]) => id === lease),
    takeover,
    agentWaiting,
    ...exhausted,
  };
}

// The heartbeat handler for live view (heartbeat.ts). visible: keeps this lease's watch, and its takeover if it
// holds one, from lapsing for HOLD_LAPSE_MS, waking the computer when it starts; hidden: lets both lapse
// HOLD_LAPSE_MS from now; released: ends both at once, and remembers the release (RELEASED_LEASE_MS). Then the
// lease's status.
export async function liveViewHeartbeat(
  db: Database,
  computers: Computers,
  member: Member,
  { id: lease, state }: { id: string; state: 'visible' | 'hidden' | 'released' },
  now = new Date(),
  target: LiveViewTarget = {},
): Promise<LiveViewStatus> {
  if (!LEASE_PATTERN.test(lease)) throw new Error('invalid live view lease');
  if (state === 'visible') await extendHolds(db, computers, member, lease, now, target);
  else
    await db.transaction(async tx => {
      const computer = await lockLiveView(tx, member, now, target);
      if (!computer) return;
      const watches = keptWatches(computer.liveViewWatches, now);
      if (state === 'released') {
        const held = typeof watches[lease] === 'string' || mine(computer, lease, now);
        watches[lease] = { released: now.toISOString() };
        if (!held) {
          await tx
            .update(schema.computers)
            .set({ liveViewWatches: watches })
            .where(eq(schema.computers.id, computer.id));
          return;
        }
        const ended = mine(computer, lease, now) ? await endTakeover(tx, computer, now) : computer;
        return shortenHolds(
          tx,
          computers,
          member,
          ended,
          { liveViewWatches: watches, takeoverUntil: ended.takeoverUntil },
          now,
        );
      }
      const lapseAt = new Date(now.getTime() + HOLD_LAPSE_MS);
      const watch = watches[lease];
      const shortenWatch = typeof watch === 'string' && Date.parse(watch) > lapseAt.getTime();
      const shortenTakeover = mine(computer, lease, now) && computer.takeoverUntil! > lapseAt;
      if (!shortenWatch && !shortenTakeover) return;
      if (shortenWatch) watches[lease] = lapseAt.toISOString();
      return shortenHolds(
        tx,
        computers,
        member,
        computer,
        { liveViewWatches: watches, takeoverUntil: shortenTakeover ? lapseAt : computer.takeoverUntil },
        now,
      );
    });
  return liveViewStatus(db, computers.metering, member, lease, now, target);
}
// The holds a visible heartbeat extends, once less than HOLD_LAPSE_MS is left: this lease's watch (a new one only
// below MAX_LIVE_WATCHES, and never for a released lease) and its takeover. Null when nothing needs extending.
function extendedHolds(computer: LiveViewComputer, lease: string, now: Date) {
  if (released(computer.liveViewWatches, lease, now)) return null;
  const soon = now.getTime() + HOLD_LAPSE_MS;
  const until = new Date(soon + HOLD_EXTEND_STEP_MS);
  const watches = keptWatches(computer.liveViewWatches, now);
  const watch = watches[lease] as string | undefined;
  const full = !watch && liveWatches(watches, now).length >= MAX_LIVE_WATCHES;
  const extendWatch = !full && (!watch || Date.parse(watch) < soon);
  const extendTakeover = mine(computer, lease, now) && computer.takeoverUntil!.getTime() < soon;
  if (!extendWatch && !extendTakeover) return null;
  if (extendWatch) watches[lease] = until.toISOString();
  return { liveViewWatches: watches, takeoverUntil: extendTakeover ? until : computer.takeoverUntil };
}
// Meters and wakes the computer for an extended hold, as startCall does for a call. Most beats find nothing
// to extend, or a lapsed takeover to end, in a read without the lock. The wake runs under the computer row lock, so a
// release or hand-back that follows pauses the computer this wakes, rather than this wake undoing it.
async function extendHolds(
  db: Database,
  computers: Computers,
  member: Member,
  lease: string,
  now: Date,
  target: LiveViewTarget,
) {
  const { provider, metering } = computers;
  const deadline = Date.now() + SYNC_DEADLINE_MS;
  const ready = () => db.select(liveViewColumns).from(schema.computers).where(readyTarget(member, target));
  let [current] = await ready();
  // Watching creates the main computer when there is none, as a takeover does; later beats see `starting` meanwhile.
  let created = false;
  if (!current?.sandboxId) {
    if (target.computerId) return;
    if (await allowanceFailure(metering, db, member)) return;
    const row = await ensureComputer(db, computers, member);
    if ('error' in row) return;
    [current] = await ready();
    if (!current?.sandboxId) return;
    created = true;
  }
  const extend = !!extendedHolds(current, lease, now) && !(await allowanceFailure(metering, db, member));
  if (!extend && !lapsed(current, now)) return;
  const woken = await db.transaction(async tx => {
    // Also ends a lapsed takeover.
    const computer = await lockLiveView(tx, member, now, target);
    const next = extend && computer && extendedHolds(computer, lease, now);
    if (!computer || !next) return null;
    await tx
      .update(schema.computers)
      .set({
        liveViewWatches: next.liveViewWatches,
        ...(next.takeoverUntil !== computer.takeoverUntil ? { takeoverUntil: next.takeoverUntil } : {}),
      })
      .where(eq(schema.computers.id, computer.id));
    const live = await liveSession(tx, computer.id);
    const pause = pauseAt({ ...computer, ...next }, live, now);
    // A running computer already due to run past the new deadline was already asked to run that long. Metered first,
    // like a call: a failed wake still counts as running, and the page's next beats show the computer paused.
    if (running(computer, now) && computer.runsUntil! >= pause && !created) return null;
    await meter(tx, metering, computer.id, member, pause);
    const session = await provider
      .connect(computer.sandboxId!, Math.max(1, pause.getTime() - Date.now()))
      .catch(error => logError('live view wake', error));
    // A computer this created has had no computer session, so it gets the latest capture as a new one would on
    // computer_open; watching an existing computer applies nothing.
    const working = !!live || liveCalls(computer.callsInFlight, now).length > 0;
    return session && created && !working ? { session, row: computer } : null;
  });
  if (!woken) return;
  try {
    await Promise.all([
      applyForLiveView(db, member, woken.row, woken.session, deadline),
      applyTimeZone(db, woken.row.id, woken.session),
    ]);
  } catch (error) {
    logError('live view apply', error);
  }
}

// The user takes control through live view, for this lease. An agent working, with a live computer session
// (even past its idle minute) or a call in flight (a computer_close ends its session before it applies and closes
// tabs), is suspended or left to finish, and nothing is applied under it; with none, this is a session boundary like
// computer_open: it creates or wakes the computer and applies pending captures first, but does not mark the user set
// up. A takeover another of the user's pages holds moves to this one. Charged ahead to its lapse deadline. A computer
// that accepts public traffic is refused (needs_reset), since live view could not reach it privately.
export async function takeOverComputer(
  db: Database,
  computers: Computers,
  member: Member,
  lease: string,
  target: LiveViewTarget = {},
): Promise<LiveViewStatus | ComputerFailure> {
  if (!LEASE_PATTERN.test(lease)) throw new Error('invalid live view lease');
  const { provider, metering } = computers;
  const deadline = Date.now() + SYNC_DEADLINE_MS;
  const exhausted = await allowanceFailure(metering, db, member);
  if (exhausted) return exhausted;
  // A fork is never created here: only the main computer, on first use.
  const row = target.computerId
    ? ((await db.select(computerColumns).from(schema.computers).where(readyTarget(member, target)))[0] ?? forkNotFound)
    : await ensureComputer(db, computers, member);
  if ('error' in row) return row;
  let started: { session: ComputerSession; apply: boolean } | ComputerFailure;
  try {
    started = await db.transaction(
      async (tx): Promise<{ session: ComputerSession; apply: boolean } | ComputerFailure> => {
        const now = new Date();
        const computer = await lockLiveView(tx, member, now, target);
        if (!computer || computer.id !== row.id) return resetting;
        let live = await liveSession(tx, computer.id);
        if (live && expired(live, now)) {
          await endSession(tx, live.id, 'idle', now);
          live = null;
        }
        const fresh = !takenOver(computer, now);
        const working = !!live || liveCalls(computer.callsInFlight, now).length > 0;
        if (live && !live.suspendedAt)
          await tx
            .update(schema.computerSessions)
            .set({ suspendedAt: now })
            .where(eq(schema.computerSessions.id, live.id));
        const until = new Date(now.getTime() + HOLD_LAPSE_MS + HOLD_EXTEND_STEP_MS);
        const watches = { ...keptWatches(computer.liveViewWatches, now), [lease]: until.toISOString() };
        await tx
          .update(schema.computers)
          .set({
            takeoverLease: lease,
            takenOverAt: fresh ? now : computer.takenOverAt,
            takeoverUntil: until,
            liveViewWatches: watches,
          })
          .where(eq(schema.computers.id, computer.id));
        // The suspended session keeps nothing running; its calls in flight do (callsInFlight).
        const pause = pauseAt({ ...computer, liveViewWatches: watches, takeoverUntil: until }, null, now);
        await meter(tx, metering, computer.id, member, pause);
        // Under the lock, so a release or hand-back that follows pauses what this wakes. A failure rolls the takeover
        // and its metering back.
        const session = await provider.connect(computer.sandboxId!, Math.max(1, pause.getTime() - Date.now()));
        // Rolled back too, though the connect woke the computer: only computers made before computers were private, until reset.
        if (!session.isPrivate) throw new PublicComputer();
        return { session, apply: fresh && !working };
      },
    );
  } catch (error) {
    if (error instanceof PublicComputer) return needsReset;
    throw error;
  }
  if ('error' in started) return started;
  if (started.apply)
    try {
      // As computer_open does: before the apply, which needs the browser this may restart.
      await refreshComputer(db, provider, row, started.session);
      await Promise.all([
        applyForLiveView(db, member, row, started.session, deadline),
        applyTimeZone(db, row.id, started.session),
      ]);
    } catch (error) {
      // The computer is unreachable: give the takeover back rather than hold a computer nobody can use.
      await handBackComputer(db, computers, member, lease, target).catch(endError =>
        logError('takeover cleanup', endError),
      );
      throw error;
    }
  return liveViewStatus(db, metering, member, lease, undefined, target);
}
class PublicComputer extends Error {}
const needsReset: ComputerFailure = {
  error: 'needs_reset',
  message:
    'Your computer was made before live view and can only be watched once it is reset. Reset it on your account page: that deletes sign-ins and files made on it.',
};

// Ends this lease's takeover, keeping its watch, and resumes the suspended computer session with no apply; its
// next result says the user had control. The computer pauses once nothing else keeps it running. A takeover another
// lease holds is left alone. The end of a takeover of the main computer takes its new snapshot, so the next fork has
// what the member signed in to; a failure leaves it due, for the next fork to retry.
export async function handBackComputer(
  db: Database,
  computers: Computers,
  member: Member,
  lease: string,
  target: LiveViewTarget = {},
): Promise<LiveViewStatus> {
  if (!LEASE_PATTERN.test(lease)) throw new Error('invalid live view lease');
  const now = new Date();
  const main = await db.transaction(async tx => {
    const computer = await lockLiveView(tx, member, now, target);
    if (!computer || !mine(computer, lease, now)) return null;
    const ended = await endTakeover(tx, computer, now);
    await shortenHolds(
      tx,
      computers,
      member,
      ended,
      { liveViewWatches: ended.liveViewWatches, takeoverUntil: null },
      now,
    );
    return computer.forkOf === null ? computer.id : null;
  });
  if (main) await latestSnapshot(db, computers, member, main).catch(error => logError('computer snapshot', error));
  return liveViewStatus(db, computers.metering, member, lease, now, target);
}

// What this lease may do through the relay now: control while it holds the user's live takeover, view while it holds
// a live watch, and nothing once both ended (released, lapsed, or the computer reset). The relay re-reads it.
export async function liveViewAccess(
  db: Database,
  member: Member,
  lease: string,
  now = new Date(),
  target: LiveViewTarget = {},
): Promise<'control' | 'view' | 'none'> {
  if (!LEASE_PATTERN.test(lease)) return 'none';
  const [computer] = await db
    .select({
      takeoverLease: schema.computers.takeoverLease,
      takeoverUntil: schema.computers.takeoverUntil,
      liveViewWatches: schema.computers.liveViewWatches,
    })
    .from(schema.computers)
    .where(readyTarget(member, target));
  if (!computer) return 'none';
  if (mine(computer, lease, now)) return 'control';
  return liveWatches(computer.liveViewWatches, now).some(([id]) => id === lease) ? 'view' : 'none';
}

// Connects the relay for this lease: the user's ready computer, while the lease holds a live watch or the takeover,
// woken until the holds let it pause (pauseAt), as the heartbeat that extended them asked. Under the computer row
// lock, so a release that follows pauses what this wakes. Refuses a computer that accepts public traffic.
export async function connectLiveView(
  db: Database,
  provider: ComputerProvider,
  member: Member,
  lease: string,
  target: LiveViewTarget = {},
): Promise<ComputerSession | 'not_found' | 'not_watching' | 'needs_reset'> {
  if (!LEASE_PATTERN.test(lease)) return 'not_watching';
  return db.transaction(async tx => {
    const now = new Date();
    const computer = await lockLiveView(tx, member, now, target);
    if (!computer) return 'not_found';
    if (!mine(computer, lease, now) && !liveWatches(computer.liveViewWatches, now).some(([id]) => id === lease))
      return 'not_watching';
    const until = pauseAt(computer, await liveSession(tx, computer.id), now);
    const session = await provider.connect(computer.sandboxId!, Math.max(1, until.getTime() - Date.now()));
    return session.isPrivate ? session : 'needs_reset';
  });
}

// The most text live view's paste sets on the computer's clipboard, in UTF-8 bytes: the same as the relay allows RFB cut
// text (MAX_CUT_TEXT in rfb-filter.ts), which is how pasting worked before.
export const MAX_CLIPBOARD_BYTES = 1024 * 1024;

// Live view's paste: makes the user's text the computer's clipboard, for the page to send Ctrl+V after through the relay.
// Only while this lease holds the user's live takeover, so it is running. Connects under the computer row lock, as
// connectLiveView does, but sets the clipboard after it, since that is a command on the computer.
export async function setLiveViewClipboard(
  db: Database,
  provider: ComputerProvider,
  member: Member,
  lease: string,
  text: string,
  target: LiveViewTarget = {},
): Promise<'set' | 'not_in_control' | 'too_large'> {
  if (Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_BYTES) return 'too_large';
  if (!LEASE_PATTERN.test(lease)) return 'not_in_control';
  const session = await db.transaction(async tx => {
    const now = new Date();
    const computer = await lockLiveView(tx, member, now, target);
    if (!computer || !mine(computer, lease, now)) return null;
    const until = pauseAt(computer, await liveSession(tx, computer.id), now);
    return provider.connect(computer.sandboxId!, Math.max(1, until.getTime() - Date.now()));
  });
  if (!session) return 'not_in_control';
  await session.setClipboard(text, CLIPBOARD_SET_MS);
  return 'set';
}

export async function computerView(db: Database, metering: Metering, member: Member) {
  const [[row], capture, usage] = await Promise.all([
    db
      .select({
        id: schema.computers.id,
        status: schema.computers.status,
        // When main last applied any of its profiles' captures.
        appliedCaptureAt:
          sql<Date | null>`(select max(${schema.computerProfiles.appliedCaptureAt}) from ${schema.computerProfiles} where ${schema.computerProfiles.computerId} = ${schema.computers.id})`.mapWith(
            schema.computerProfiles.appliedCaptureAt,
          ),
        takeoverUntil: schema.computers.takeoverUntil,
      })
      .from(schema.computers)
      .where(mainOf(member)),
    captureView(db, member),
    metering.usage(db, member, new Date()),
  ]);
  const now = new Date();
  // Agents work in forks: busy while one of them holds a fork. Live view lists the forks that are not paused.
  const forks = row ? (await listForks(db, member, now)).filter(fork => fork.status !== 'paused') : [];
  const live = row
    ? await db
        .select({ lastCallAt: schema.computerSessions.lastCallAt, suspendedAt: schema.computerSessions.suspendedAt })
        .from(schema.computerSessions)
        .innerJoin(schema.computers, eq(schema.computers.id, schema.computerSessions.computerId))
        .where(and(eq(schema.computers.forkOf, row.id), isNull(schema.computerSessions.endedAt)))
    : [];
  return {
    capture,
    // Without an allowance (hooks.ts), null.
    usage: usage && {
      usedMinutes: Math.floor(usage.usedSeconds / 60),
      allowanceMinutes: usage.allowanceSeconds / 60,
      resetsAt: usage.resetsAt.toISOString(),
    },
    computer: row
      ? {
          status: row.status,
          appliedCaptureAt: row.appliedCaptureAt?.toISOString() ?? null,
          busy: live.some(session => holdsControl(session, now)),
          // The user holds a takeover of the main computer in live view.
          inLiveView: takenOver(row, now),
        }
      : null,
    forks,
  };
}

// Also resets the computer: deletes the main computer, its forks, and their snapshots, so the next computer_open creates
// a fresh main from the current template and applies the latest capture wholesale. Returns whether there was one.
export async function deleteMainComputer(db: Database, provider: ComputerProvider, member: Member) {
  const [main] = await db.select({ id: schema.computers.id }).from(schema.computers).where(mainOf(member));
  if (!main) return false;
  const [computers, snapshots] = await Promise.all([
    db
      .select({ publicId: schema.computers.publicId, sandboxId: schema.computers.sandboxId })
      .from(schema.computers)
      .where(or(eq(schema.computers.id, main.id), eq(schema.computers.forkOf, main.id))),
    db
      .select({ id: schema.computerSnapshots.providerSnapshotId })
      .from(schema.computerSnapshots)
      .where(eq(schema.computerSnapshots.computerId, main.id)),
  ]);
  // Every provider computer before forgetting the rows; its forks, snapshots, and computer sessions go with it (cascade).
  await destroyProviderComputers(
    provider,
    computers,
    snapshots.map(snapshot => snapshot.id),
  );
  await db.delete(schema.computers).where(eq(schema.computers.id, main.id));
  return true;
}
