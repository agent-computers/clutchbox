import 'server-only';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { captureScope } from './captures';
import type { Database } from './database';
import { logError, logSetupEvent } from './log';
import { earliestLiveConsentAt, hasLiveGrant } from './mcp';
import * as schema from './schema';

// Setup: the overview's checklist. Browser sync and Agents are read from
// current state; "set up" is recorded when an agent first opens the main computer. Every write
// here is best-effort and runs outside other transactions, so it never fails an upload or a tool call.
export type SetupStep = 'browserSynced' | 'agentConnected' | 'setUp';
type Recorded = { first: boolean; firstEver: boolean; preexisting: boolean };

// Records a step's first completion. Exactly one concurrent caller gets `first`: the UPDATE re-checks
// IS NULL after the row lock. For setUp, `first` means set up now (again after a reset), and
// `firstEver` means set up for the first time.
export async function recordSetupStep(
  db: Pick<Database, 'insert' | 'update'>,
  userId: string,
  step: SetupStep,
  at = new Date(),
): Promise<Recorded> {
  const column = step === 'browserSynced' ? schema.setups.browserSyncedAt : schema.setups.agentConnectedAt;
  const update = () =>
    step === 'setUp'
      ? db
          .update(schema.setups)
          .set({ setUpAt: at, firstSetUpAt: sql`coalesce(${schema.setups.firstSetUpAt}, ${at})` })
          .where(and(eq(schema.setups.userId, userId), isNull(schema.setups.setUpAt)))
          .returning({
            preexisting: schema.setups.preexisting,
            firstEver: sql<boolean>`${schema.setups.firstSetUpAt} = ${schema.setups.setUpAt}`,
          })
      : db
          .update(schema.setups)
          .set(step === 'browserSynced' ? { browserSyncedAt: at } : { agentConnectedAt: at })
          .where(and(eq(schema.setups.userId, userId), isNull(column)))
          .returning({ preexisting: schema.setups.preexisting, firstEver: sql<boolean>`true` });
  const [updated] = await update();
  if (updated) return { first: true, ...updated };
  const values =
    step === 'setUp'
      ? { setUpAt: at, firstSetUpAt: at }
      : step === 'browserSynced'
        ? { browserSyncedAt: at }
        : { agentConnectedAt: at };
  const [inserted] = await db
    .insert(schema.setups)
    .values({ userId, ...values })
    .onConflictDoNothing()
    .returning({ preexisting: schema.setups.preexisting });
  if (inserted) return { first: true, firstEver: true, preexisting: inserted.preexisting };
  // Another step created the row meanwhile; this step may still be unrecorded.
  const [late] = await update();
  return late ? { first: true, ...late } : { first: false, firstEver: false, preexisting: false };
}

// The best-effort wrapper every caller uses. Emits the funnel event on a first-ever completion by a
// user who signed up after setup shipped. Returns whether the step is recorded.
export async function noteSetupStep(db: Database, userId: string, step: SetupStep, at?: Date) {
  try {
    const recorded = await recordSetupStep(db, userId, step, at);
    if (recorded.firstEver && !recorded.preexisting) logSetupEvent(`setup.${step}`, { user: userId });
    return true;
  } catch (error) {
    logError(`setup ${step}`, error);
    return false;
  }
}

// Users already known to have agentConnectedAt, per database, so repeat MCP calls skip the lookup.
const agentConnected = new WeakMap<Database, Set<string>>();
// Records the agent step at the earliest live consent's time, so it reflects when the user
// connected, not when the agent first called. Never throws.
export async function noteAgentConnected(db: Database, userId: string) {
  const known = agentConnected.get(db) ?? new Set<string>();
  agentConnected.set(db, known);
  if (known.has(userId)) return;
  let at: Date | null;
  try {
    at = await earliestLiveConsentAt(db, userId);
  } catch (error) {
    logError('setup agentConnected', error);
    return;
  }
  if (at && (await noteSetupStep(db, userId, 'agentConnected', at))) known.add(userId);
}

// Delete everything: the user is no longer set up. First-completion times stay.
export async function resetSetup(db: Database, userId: string) {
  await db.update(schema.setups).set({ setUpAt: null, noticeClosedAt: null }).where(eq(schema.setups.userId, userId));
}
export async function closeSetupNotice(db: Database, userId: string) {
  await db
    .update(schema.setups)
    .set({ noticeClosedAt: new Date() })
    .where(
      and(eq(schema.setups.userId, userId), isNotNull(schema.setups.setUpAt), isNull(schema.setups.noticeClosedAt)),
    );
}

export async function setupView(db: Database, userId: string) {
  const [[row], live, scope] = await Promise.all([
    db.select().from(schema.setups).where(eq(schema.setups.userId, userId)),
    hasLiveGrant(db, userId),
    captureScope(db, userId),
  ]);
  // Covers a grant whose agent has not called yet.
  if (live) await noteAgentConnected(db, userId);
  const sync = scope === 'unreadable' ? null : scope;
  return {
    setUpAt: row?.setUpAt?.toISOString() ?? null,
    noticeOpen: !!row?.setUpAt && !row.noticeClosedAt,
    items: {
      // An unreadable capture still means the user synced; the server just cannot list it now.
      browserSync: scope === 'unreadable' || (!!sync && (sync.mode === 'whole-browser' || sync.sites.length > 0)),
      agents: live,
      computer: !!row?.setUpAt,
    },
    sync: { mode: sync?.mode ?? null, sites: sync?.sites ?? [], readable: scope !== 'unreadable' },
  };
}
