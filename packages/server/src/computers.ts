import 'server-only';
import { randomUUID } from 'node:crypto';
import { cookieChanges, expiredCdpCookie, toCdpCookie } from '@agent-computers/apply';
import { siteOfCookie } from '@agent-computers/capture';
import type { ComputerProvider, ComputerSession } from '@agent-computers/computer';
import { and, eq, getTableColumns, gte, isNotNull, isNull, lt, min, sql } from 'drizzle-orm';
import { type AgentKind, agentOf, clientHost } from './agents';
import {
  captureView,
  latestCaptureDigest,
  loadLatestCapture,
  openAppliedCapture,
  sealAppliedCapture,
} from './captures';
import {
  CALL_BUDGET_MS,
  CALL_HOLD_MS,
  CLIPBOARD_SET_MS,
  CLOSE_TABS_MS,
  CREATE_STALE_MS,
  HOLD_EXTEND_STEP_MS,
  HOLD_LAPSE_MS,
  IDLE_PAUSE_MS,
  REFRESH_BUDGET_MS,
  RELEASED_LEASE_MS,
  SESSION_IDLE_END_MS,
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

// Validation prototype: one main computer per member (a person in one organization), shared by every agent through
// computer sessions. No Workflow orchestration, checkpoints, or mutation-outcome recording
// yet; those come later. Timings are in computer-timing.ts.
// Server-issued computer session IDs; access is checked against the caller, never the ID alone.
export const SESSION_ID_PATTERN = publicIdPattern('computerSession');
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
    | 'needs_reset';
  message: string;
  busyUntil?: Date | undefined;
  resetsAt?: Date | undefined;
};
// pending: the computer was paused, so a close left a newer capture for the next computer_open.
export type SyncSummary = {
  status: 'none' | 'unchanged' | 'applied' | 'failed' | 'pending';
  captureCompletedAt?: string | undefined;
  sitesUpdated?: number | undefined;
};
// Sites where a newer capture added or deleted cookies (not only rotated them), sorted.
export type PendingSync = { sites: string[] };
export type SessionHandle = {
  sessionId: string;
  session: ComputerSession;
  pending?: PendingSync | undefined;
  // The user had control of the computer in live view since this session's last call; said once.
  userHadControl?: boolean | undefined;
  // Ends the call: lets the computer pause after the idle minute.
  // Call it once the call's work is done, on every path; repeat calls are no-ops. Never throws.
  done(): Promise<void>;
};
// Re-checks the caller's access inside the control transaction (MCP: the live grant), so an in-flight
// call cannot take control after a revocation ended its sessions. Revocation locks the same user row.
export type AccessGuard = (tx: Pick<Database, 'select'>) => Promise<boolean>;
export type Caller = Member & { clientId: string; guard?: AccessGuard | undefined };
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

const resetting: ComputerFailure = {
  error: 'starting',
  message: 'The computer is being reset. Try again in a few seconds.',
};
// Exactly one caller creates the member's provider computer; others see `starting`.
async function ensureComputer(
  db: Database,
  { provider, metering }: Computers,
  member: Member,
): Promise<ComputerRow | ComputerFailure> {
  const [inserted] = await db
    .insert(schema.computers)
    .values({ userId: member.userId, membershipId: member.membershipId, publicId: newPublicId('computer') })
    .onConflictDoNothing()
    .returning(computerColumns);
  let row = inserted;
  if (!row) {
    [row] = await db
      .select(computerColumns)
      .from(schema.computers)
      .where(eq(schema.computers.membershipId, member.membershipId));
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
  const own = and(
    eq(schema.computerSessions.publicId, sessionId),
    eq(schema.computerSessions.membershipId, caller.membershipId),
    eq(schema.computerSessions.clientId, caller.clientId),
  );
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
  if (session.endedAt) return ended;
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
async function endTakeover<C extends Pick<ComputerRow, 'id' | 'takeoverUntil' | 'takeoverLease' | 'takenOverAt'>>(
  tx: Transaction,
  computer: C,
  now: Date,
): Promise<C> {
  const resumedAt = computer.takeoverUntil && computer.takeoverUntil < now ? computer.takeoverUntil : now;
  const cleared = { takeoverLease: null, takenOverAt: null, takeoverUntil: null };
  await tx.update(schema.computers).set(cleared).where(eq(schema.computers.id, computer.id));
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
// deadline, so nobody takes over mid-call, and keeps other calls' ends from letting the computer pause.
async function beginCall(
  tx: Transaction,
  computer: Pick<ComputerRow, 'id' | 'callsInFlight'>,
  sessionId: number,
  now: Date,
) {
  const id = randomUUID();
  const until = new Date(now.getTime() + CALL_BUDGET_MS);
  await tx
    .update(schema.computers)
    .set({
      callsInFlight: Object.fromEntries([
        ...liveCalls(computer.callsInFlight, now),
        [id, { sessionId, until: until.toISOString() }],
      ]),
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
// Meters and connects for the call's hold. The returned done() must run after the call's work.
async function startCall(db: Database, { provider, metering }: Computers, call: Call, sandboxId: string) {
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
    await meterRun(db, metering, call.computerId, call.member, CALL_HOLD_MS);
    markToolStep('connect');
    session = await provider.connect(sandboxId, CALL_HOLD_MS);
  } catch (error) {
    await done();
    throw error;
  }
  return { session, done };
}

// Starts a computer session for the caller, applying any pending capture first. With the caller's own
// live sessionId it replaces that session without `busy`; another session holding control means `busy`.
// Callers must already have verified the live MCP grant and pass a guard that re-checks it.
export async function openComputerSession(
  db: Database,
  computers: Computers,
  caller: Caller,
  { sessionId }: { sessionId?: string | undefined } = {},
): Promise<(SessionHandle & { sync: SyncSummary }) | ComputerFailure> {
  const deadline = Date.now() + SYNC_DEADLINE_MS;
  const exhausted = await allowanceFailure(computers.metering, db, caller);
  if (exhausted) return exhausted;
  const row = await ensureComputer(db, computers, caller);
  if ('error' in row) return row;
  const started = await db.transaction(
    async (
      tx,
    ): Promise<
      { id: number; publicId: string; callId: string; sandboxId: string; userHadControl: boolean } | ComputerFailure
    > => {
      const denied = await guardFailure(tx, caller);
      if (denied) return denied;
      let [computer] = await tx
        .select(computerColumns)
        .from(schema.computers)
        .where(and(eq(schema.computers.id, row.id), eq(schema.computers.status, 'ready')))
        .for('update');
      if (!computer?.sandboxId) return resetting;
      const { sandboxId } = computer;
      const now = new Date();
      let live = await liveSession(tx, computer.id);
      if (lapsed(computer, now)) {
        computer = await endTakeover(tx, computer, now);
        live = await liveSession(tx, computer.id);
      }
      const own =
        !!live &&
        !!sessionId &&
        live.publicId === sessionId &&
        live.membershipId === caller.membershipId &&
        live.clientId === caller.clientId;
      // The user's takeover: the session it suspended waits for the hand-back; everyone else is busy until then.
      if (takenOver(computer, now)) return own && live?.suspendedAt ? userInControl : userBusy;
      if (live) {
        if (!own && holdsControl(live, now)) {
          const busyUntil = new Date(live.lastCallAt.getTime() + IDLE_PAUSE_MS);
          return {
            error: 'busy',
            busyUntil,
            message: `Another computer session is using this computer: another agent, or one of yours whose session_id was not passed. Try again after ${busyUntil.toISOString()}, when its idle minute ends.`,
          };
        }
        await endSession(tx, live.id, expired(live, now) ? 'idle' : own ? 'replaced' : 'superseded', now);
      }
      const publicId = newPublicId('computerSession', now.getTime());
      const [{ id }] = (await tx
        .insert(schema.computerSessions)
        .values({
          publicId,
          userId: caller.userId,
          membershipId: caller.membershipId,
          clientId: caller.clientId,
          computerId: computer.id,
          createdAt: now,
          lastCallAt: now,
        })
        .returning({ id: schema.computerSessions.id })) as [{ id: number }];
      const callId = await beginCall(tx, computer, id, now);
      // Reopening its own session right after a hand-back: the new one's first result says the user had control.
      return { id, publicId, callId, sandboxId, userHadControl: own && !!live?.handedBackAt };
    },
  );
  if ('error' in started) return started;
  const call = { id: started.callId, sessionId: started.id, computerId: row.id, member: caller };
  let done: (() => Promise<void>) | undefined;
  try {
    const handle = await startCall(db, computers, call, started.sandboxId);
    done = handle.done;
    markToolStep('sync');
    // Before the apply, which needs the browser this may restart.
    await refreshComputer(db, computers.provider, row, handle.session);
    const [sync] = await Promise.all([
      applyLatestCapture(db, caller, row.id, handle.session, deadline),
      applyTimeZone(db, row.id, handle.session),
    ]);
    return {
      sessionId: started.publicId,
      session: handle.session,
      sync,
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

// One call within the caller's live computer session: resumes the computer without applying, and says
// whether a newer capture is waiting (pending) and, once after a hand-back, that the user had control.
export async function useComputerSession(
  db: Database,
  computers: Computers,
  caller: Caller,
  sessionId: string,
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
        callId: await beginCall(tx, computer, session.id, new Date()),
        handedBackAt: session.handedBackAt,
      };
    },
  );
  if ('error' in started) return started;
  const { computer, handedBackAt } = started;
  const call = { id: started.callId, sessionId: started.sessionKey, computerId: computer.id, member: caller };
  const { session, done } = await startCall(db, computers, call, computer.sandboxId!);
  try {
    const pending = await pendingSync(db, caller, computer);
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
    return {
      sessionId,
      session,
      done,
      ...(pending ? { pending } : {}),
      ...(handedBackAt ? { userHadControl: true } : {}),
    };
  } catch (error) {
    await done();
    throw error;
  }
}

// Ends the caller's computer session at once, so no later call can use it. A computer still running (within
// the idle minute) gets any pending capture applied, its browser tabs closed, and is paused unless live view
// still holds it. A paused one is never woken: its pending
// capture waits for the next computer_open. A session the user's takeover suspended is only ended: nothing is
// applied or closed under the user.
export async function closeComputerSession(
  db: Database,
  { provider, metering }: Computers,
  caller: Caller,
  sessionId: string,
): Promise<{ sync: SyncSummary } | ComputerFailure> {
  const deadline = Date.now() + SYNC_DEADLINE_MS;
  if (!SESSION_ID_PATTERN.test(sessionId)) return notFound;
  const started = await db.transaction(
    async (tx): Promise<{ computer: ComputerRow; sessionKey: number; callId: string | null } | ComputerFailure> => {
      const denied = await guardFailure(tx, caller);
      if (denied) return denied;
      const now = new Date();
      const locked = await lockSession(tx, caller, sessionId, now, { close: true });
      if ('error' in locked) return locked;
      const { computer, session } = locked;
      await endSession(tx, session.id, 'closed', now);
      if (session.suspendedAt) return { computer, sessionKey: session.id, callId: null };
      const awake = holdsControl(session, now) || running(computer, now);
      return {
        computer,
        sessionKey: session.id,
        callId: awake ? await beginCall(tx, computer, session.id, now) : null,
      };
    },
  );
  if ('error' in started) return started;
  const { computer, sessionKey, callId } = started;
  const sandboxId = computer.sandboxId!;
  if (!callId) return { sync: await syncState(db, caller, computer) };
  // The user may take over while this close runs, after its session ended: that takeover applies nothing while this
  // call is in flight, and this close then neither applies nor closes tabs under the user.
  const userTookOver = async () => {
    const [row] = await db
      .select({ takeoverUntil: schema.computers.takeoverUntil })
      .from(schema.computers)
      .where(eq(schema.computers.id, computer.id));
    return !!row && takenOver(row, new Date());
  };
  let sync: SyncSummary;
  let session: ComputerSession | null = null;
  try {
    await meterRun(db, metering, computer.id, caller, CALL_HOLD_MS);
    session = await provider.connect(sandboxId, CALL_HOLD_MS);
    sync = (await userTookOver())
      ? await syncState(db, caller, computer)
      : await applyLatestCapture(db, caller, computer.id, session, deadline);
  } catch (error) {
    logError('computer close apply', error);
    sync = { status: 'failed' };
  }
  // Best effort, so the next task starts from one blank tab; a missed one is caught up by the next close.
  const closeTabs = async (connected: ComputerSession) => {
    if (!(await userTookOver())) await withinBudget(connected.closeTabs(), CLOSE_TABS_MS);
  };
  if (session) await closeTabs(session).catch(error => logError('computer close tabs', error));
  // Pauses at once unless another call is in flight or live view holds the computer (pauseAt).
  const call = { id: callId, sessionId: sessionKey, computerId: computer.id, member: caller };
  await finishCall(
    db,
    metering,
    call,
    async timeoutMs => {
      if (!timeoutMs) return provider.pause(sandboxId);
      if (!session) throw new Error('not connected');
      await session.setTimeout(timeoutMs);
    },
    { close: true },
  ).catch(error => logError('computer close pause', error));
  return { sync };
}

// The sync state without applying (a close that does not wake a paused computer).
async function syncState(db: Database, member: Owner, computer: ComputerRow): Promise<SyncSummary> {
  const latest = await latestCaptureDigest(db, member);
  if (!latest) return { status: 'none' };
  return {
    status: latest.digest === computer.appliedCaptureDigest ? 'unchanged' : 'pending',
    captureCompletedAt: latest.completedAt,
  };
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
// The pending notice: sites where a newer capture adds or deletes cookies. Rotations alone wait silently.
async function pendingSync(db: Database, member: Owner, computer: ComputerRow): Promise<PendingSync | null> {
  try {
    const latest = await latestCaptureDigest(db, member);
    if (!latest || latest.digest === computer.appliedCaptureDigest) return null;
    const [[sealed], loaded] = await Promise.all([
      db
        .select({ appliedCapture: schema.computers.appliedCapture })
        .from(schema.computers)
        .where(eq(schema.computers.id, computer.id)),
      loadLatestCapture(db, member),
    ]);
    if (!loaded) return null;
    const { addedOrRemovedSites } = cookieChanges(
      baselineOf(sealed?.appliedCapture ?? null, member, computer.publicId),
      loaded.capture.cookies,
      computer.syncedSites,
      loaded.completedAt,
    );
    return addedOrRemovedSites.length ? { sites: addedOrRemovedSites } : null;
  } catch (error) {
    logError('pending sync', error);
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
  sql`array(select distinct unnest(${schema.computers.syncedSites} || ${textArray(sites)}))`;

// Apply between computer sessions: only cookies the host added, changed, or deleted since
// the last applied capture (cookieChanges), so the host wins what it changed and the computer keeps the rest.
// Without a baseline each target site is replaced wholesale. A failure never blocks the open or close.
async function applyLatestCapture(
  db: Database,
  member: Owner,
  computerId: number,
  session: ComputerSession,
  deadline: number,
): Promise<SyncSummary> {
  const [[computer], latest] = await Promise.all([
    db.select().from(schema.computers).where(eq(schema.computers.id, computerId)),
    latestCaptureDigest(db, member),
  ]);
  if (!latest || !computer) return { status: 'none' };
  if (latest.digest === computer.appliedCaptureDigest)
    return { status: 'unchanged', captureCompletedAt: latest.completedAt };
  let targetSites: string[] | undefined;
  try {
    const budget = Math.min(SYNC_BUDGET_MS, deadline - Date.now() - SYNC_SLACK_MS);
    if (budget < SYNC_MIN_MS) throw new Error('no time left');
    const loaded = await loadLatestCapture(db, member);
    if (!loaded) return { status: 'none' };
    const changes = cookieChanges(
      baselineOf(computer.appliedCapture, member, computer.publicId),
      loaded.capture.cookies,
      computer.syncedSites,
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
          clearSites: changes.clearSites,
          cookies: [...changes.set.map(toCdpCookie), ...changes.remove.map(expiredCdpCookie)],
          budgetMs: budget,
        }),
        budget + SYNC_SLACK_MS,
      );
    }
    // Conditional on the state read above: a concurrent apply may have won.
    const [updated] = await db
      .update(schema.computers)
      .set({
        appliedCaptureDigest: loaded.digest,
        appliedCaptureAt: new Date(loaded.completedAt),
        syncedSites: next,
        appliedCapture: sealAppliedCapture(
          { completedAt: loaded.completedAt, cookies: loaded.capture.cookies },
          member,
          computer.publicId,
        ),
      })
      .where(
        and(
          eq(schema.computers.id, computerId),
          sql`${schema.computers.appliedCaptureDigest} IS NOT DISTINCT FROM ${computer.appliedCaptureDigest}`,
        ),
      )
      .returning({ digest: schema.computers.appliedCaptureDigest });
    if (!updated) {
      // Unless the winner applied this same capture, keep both site sets and re-apply wholesale next time.
      await db
        .update(schema.computers)
        .set({ appliedCaptureDigest: null, appliedCapture: null, syncedSites: unionSites(next) })
        .where(
          and(
            eq(schema.computers.id, computerId),
            sql`${schema.computers.appliedCaptureDigest} IS DISTINCT FROM ${loaded.digest}`,
          ),
        );
    }
    return { status: 'applied', captureCompletedAt: loaded.completedAt, sitesUpdated: sites.size };
  } catch {
    console.error('Browser sync could not be applied to the main computer; the next open retries.');
    // A cookie write may have been cut short: the computer no longer matches the baseline.
    if (targetSites)
      await db
        .update(schema.computers)
        .set({ appliedCapture: null, syncedSites: unionSites(targetSites) })
        .where(eq(schema.computers.id, computerId))
        .catch(error => logError('sync baseline reset', error));
    return { status: 'failed', captureCompletedAt: latest.completedAt };
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
      .leftJoin(schema.userSettings, eq(schema.userSettings.userId, schema.computers.userId))
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
  status: schema.computers.status,
  sandboxId: schema.computers.sandboxId,
  runsUntil: schema.computers.runsUntil,
  callsInFlight: schema.computers.callsInFlight,
  liveViewWatches: schema.computers.liveViewWatches,
  takeoverLease: schema.computers.takeoverLease,
  takenOverAt: schema.computers.takenOverAt,
  takeoverUntil: schema.computers.takeoverUntil,
};
// The member's ready computer, locked, with a lapsed takeover ended; null without one.
async function lockLiveView(tx: Transaction, member: Member, now: Date): Promise<LiveViewComputer | null> {
  const [computer] = await tx
    .select(liveViewColumns)
    .from(schema.computers)
    .where(and(eq(schema.computers.membershipId, member.membershipId), eq(schema.computers.status, 'ready')))
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
): Promise<LiveViewStatus> {
  const [[computer], refusal] = await Promise.all([
    db.select(liveViewColumns).from(schema.computers).where(eq(schema.computers.membershipId, member.membershipId)),
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
    if (waiting?.since)
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
): Promise<LiveViewStatus> {
  if (!LEASE_PATTERN.test(lease)) throw new Error('invalid live view lease');
  if (state === 'visible') await extendHolds(db, computers, member, lease, now);
  else
    await db.transaction(async tx => {
      const computer = await lockLiveView(tx, member, now);
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
  return liveViewStatus(db, computers.metering, member, lease, now);
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
async function extendHolds(db: Database, computers: Computers, member: Member, lease: string, now: Date) {
  const { provider, metering } = computers;
  const deadline = Date.now() + SYNC_DEADLINE_MS;
  const ready = () =>
    db
      .select(liveViewColumns)
      .from(schema.computers)
      .where(and(eq(schema.computers.membershipId, member.membershipId), eq(schema.computers.status, 'ready')));
  let [current] = await ready();
  // Watching creates the computer when there is none, as a takeover does; later beats see `starting` meanwhile.
  let created = false;
  if (!current?.sandboxId) {
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
    const computer = await lockLiveView(tx, member, now);
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
      applyLatestCapture(db, member, woken.row.id, woken.session, deadline),
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
): Promise<LiveViewStatus | ComputerFailure> {
  if (!LEASE_PATTERN.test(lease)) throw new Error('invalid live view lease');
  const { provider, metering } = computers;
  const deadline = Date.now() + SYNC_DEADLINE_MS;
  const exhausted = await allowanceFailure(metering, db, member);
  if (exhausted) return exhausted;
  const row = await ensureComputer(db, computers, member);
  if ('error' in row) return row;
  let started: { session: ComputerSession; apply: boolean } | ComputerFailure;
  try {
    started = await db.transaction(
      async (tx): Promise<{ session: ComputerSession; apply: boolean } | ComputerFailure> => {
        const now = new Date();
        const computer = await lockLiveView(tx, member, now);
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
        applyLatestCapture(db, member, row.id, started.session, deadline),
        applyTimeZone(db, row.id, started.session),
      ]);
    } catch (error) {
      // The computer is unreachable: give the takeover back rather than hold a computer nobody can use.
      await handBackComputer(db, computers, member, lease).catch(endError => logError('takeover cleanup', endError));
      throw error;
    }
  return liveViewStatus(db, metering, member, lease);
}
class PublicComputer extends Error {}
const needsReset: ComputerFailure = {
  error: 'needs_reset',
  message:
    'Your computer was made before live view and can only be watched once it is reset. Reset it on your account page: that deletes sign-ins and files made on it.',
};

// Ends this lease's takeover, keeping its watch, and resumes the suspended computer session with no apply; its
// next result says the user had control. The computer pauses once nothing else keeps it running. A takeover another lease holds is left alone.
export async function handBackComputer(
  db: Database,
  computers: Computers,
  member: Member,
  lease: string,
): Promise<LiveViewStatus> {
  if (!LEASE_PATTERN.test(lease)) throw new Error('invalid live view lease');
  const now = new Date();
  await db.transaction(async tx => {
    const computer = await lockLiveView(tx, member, now);
    if (!computer || !mine(computer, lease, now)) return;
    const ended = await endTakeover(tx, computer, now);
    await shortenHolds(
      tx,
      computers,
      member,
      ended,
      { liveViewWatches: ended.liveViewWatches, takeoverUntil: null },
      now,
    );
  });
  return liveViewStatus(db, computers.metering, member, lease, now);
}

// What this lease may do through the relay now: control while it holds the user's live takeover, view while it holds
// a live watch, and nothing once both ended (released, lapsed, or the computer reset). The relay re-reads it.
export async function liveViewAccess(
  db: Database,
  member: Member,
  lease: string,
  now = new Date(),
): Promise<'control' | 'view' | 'none'> {
  if (!LEASE_PATTERN.test(lease)) return 'none';
  const [computer] = await db
    .select({
      takeoverLease: schema.computers.takeoverLease,
      takeoverUntil: schema.computers.takeoverUntil,
      liveViewWatches: schema.computers.liveViewWatches,
    })
    .from(schema.computers)
    .where(and(eq(schema.computers.membershipId, member.membershipId), eq(schema.computers.status, 'ready')));
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
): Promise<ComputerSession | 'not_found' | 'not_watching' | 'needs_reset'> {
  if (!LEASE_PATTERN.test(lease)) return 'not_watching';
  return db.transaction(async tx => {
    const now = new Date();
    const computer = await lockLiveView(tx, member, now);
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
): Promise<'set' | 'not_in_control' | 'too_large'> {
  if (Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_BYTES) return 'too_large';
  if (!LEASE_PATTERN.test(lease)) return 'not_in_control';
  const session = await db.transaction(async tx => {
    const now = new Date();
    const computer = await lockLiveView(tx, member, now);
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
        appliedCaptureAt: schema.computers.appliedCaptureAt,
        takeoverUntil: schema.computers.takeoverUntil,
      })
      .from(schema.computers)
      .where(eq(schema.computers.membershipId, member.membershipId)),
    captureView(db, member),
    metering.usage(db, member, new Date()),
  ]);
  const [live] = row
    ? await db
        .select({ lastCallAt: schema.computerSessions.lastCallAt, suspendedAt: schema.computerSessions.suspendedAt })
        .from(schema.computerSessions)
        .where(and(eq(schema.computerSessions.computerId, row.id), isNull(schema.computerSessions.endedAt)))
    : [];
  const now = new Date();
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
          busy: !!live && holdsControl(live, now),
          // The user holds a takeover in live view; agents get busy meanwhile.
          inLiveView: takenOver(row, now),
        }
      : null,
  };
}

// Also resets the computer: the next computer_open creates a fresh one from the current template and applies
// the latest capture wholesale. Returns whether there was one.
export async function deleteMainComputer(db: Database, provider: ComputerProvider, member: Member) {
  const [row] = await db
    .select({ id: schema.computers.id, publicId: schema.computers.publicId, sandboxId: schema.computers.sandboxId })
    .from(schema.computers)
    .where(eq(schema.computers.membershipId, member.membershipId));
  if (!row) return false;
  // Kill both the recorded and any unrecorded provider computer before forgetting the row.
  for (const sandboxId of new Set([row.sandboxId, await provider.find(row.publicId)]))
    if (sandboxId) await provider.kill(sandboxId);
  // Its computer sessions go with it (cascade).
  await db.delete(schema.computers).where(eq(schema.computers.id, row.id));
  return true;
}
