import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { TOOL_CALL_RETENTION_MS } from './computer-timing';
import type { Database } from './database';
import { publicIdPattern } from './ids';
import { errorLabel, logError } from './log';
import type { Member } from './organizations';
import * as schema from './schema';

// MCP tool call records: what each call was, how long it took, and how it ended,
// for debugging and usage. Never a call's arguments or results, which can hold typed passwords, commands,
// cookies, or page content. Writes are best-effort, so they never fail a tool call.
export type ToolStep = (typeof schema.TOOL_CALL_STEPS)[number];
// The call's progress, which the services mark as they reach each step.
export type ToolTrace = { step: ToolStep | null; errorClass: string | null };
const traces = new AsyncLocalStorage<ToolTrace>();
// Old rows each record deletes: more than one, so a backlog drains while calls continue.
const PRUNE_BATCH = 10;
const SESSION_ID_PATTERN = publicIdPattern('computerSession');

export const withToolTrace = <T>(trace: ToolTrace, work: () => Promise<T>) => traces.run(trace, work);
export function markToolStep(step: ToolStep) {
  const trace = traces.getStore();
  if (trace) trace.step = step;
}
// A tool's caught failure: logged like any error, and its class kept for the call's record.
export function toolCallFailed(scope: string, error: unknown) {
  logError(scope, error);
  const trace = traces.getStore();
  if (trace) trace.errorClass = errorLabel(error);
}

export async function recordToolCall(
  db: Database,
  call: {
    member: Member;
    clientId: string;
    tool: string;
    // The computer session the call named or opened; linked only if it is the caller's own.
    sessionId: string | null;
    startedAt: Date;
    endedAt: Date;
    error: string | null;
    trace: ToolTrace;
  },
) {
  try {
    const { member, sessionId, trace, ...row } = call;
    await db.insert(schema.toolCalls).values({
      ...row,
      membershipId: member.membershipId,
      computerSessionId:
        sessionId && SESSION_ID_PATTERN.test(sessionId)
          ? sql`(SELECT ${schema.computerSessions.id} FROM ${schema.computerSessions} WHERE ${and(
              eq(schema.computerSessions.publicId, sessionId),
              eq(schema.computerSessions.membershipId, member.membershipId),
              eq(schema.computerSessions.clientId, call.clientId),
            )})`
          : null,
      failedStep: call.error ? trace.step : null,
      errorClass: trace.errorClass?.slice(0, 100) ?? null,
    });
    // Retention without a scheduled job: each record deletes a few of the oldest expired rows.
    const expired = db
      .select({ id: schema.toolCalls.id })
      .from(schema.toolCalls)
      .where(lt(schema.toolCalls.startedAt, new Date(call.endedAt.getTime() - TOOL_CALL_RETENTION_MS)))
      .orderBy(schema.toolCalls.startedAt)
      .limit(PRUNE_BATCH)
      .for('update', { skipLocked: true });
    await db.delete(schema.toolCalls).where(inArray(schema.toolCalls.id, expired));
  } catch (error) {
    logError('tool call record', error);
  }
}

// Delete everything: the member's calls in this organization.
export async function deleteToolCalls(db: Database, member: Member) {
  await db.delete(schema.toolCalls).where(eq(schema.toolCalls.membershipId, member.membershipId));
}
