import 'server-only';
import { z } from 'zod';
import { type Computers, liveViewHeartbeat } from './computers';
import type { Database } from './database';
import type { Member } from './organizations';

// The general-purpose heartbeat: a page reports each lease it holds, by kind, to
// POST /api/v1/heartbeat, and each kind's handler keeps its own state where its logic lives, writing only when a
// deadline or state changes, and returns the lease's status. There is no heartbeat table.
export const HEARTBEAT_STATES = ['visible', 'hidden', 'released'] as const;
export type HeartbeatState = (typeof HEARTBEAT_STATES)[number];
export type HeartbeatDeps = Computers;
export type HeartbeatHandler = (
  db: Database,
  deps: HeartbeatDeps,
  member: Member,
  lease: { id: string; state: HeartbeatState },
  now: Date,
) => Promise<unknown>;

const handlers = {
  'live-view': liveViewHeartbeat,
} satisfies Record<string, HeartbeatHandler>;
export type HeartbeatKind = keyof typeof handlers;
export const HEARTBEAT_KINDS = Object.keys(handlers) as [HeartbeatKind, ...HeartbeatKind[]];

// A page holds a few leases at most; an unknown kind fails validation (400).
export const heartbeatSchema = z
  .object({
    leases: z
      .array(z.object({ kind: z.enum(HEARTBEAT_KINDS), id: z.uuid(), state: z.enum(HEARTBEAT_STATES) }).strict())
      .min(1)
      .max(8),
  })
  .strict();
export type Heartbeat = z.infer<typeof heartbeatSchema>;

// One at a time, so a page's leases on the same row never contend for its lock.
export async function heartbeat(db: Database, deps: HeartbeatDeps, member: Member, body: Heartbeat, now = new Date()) {
  const leases = [];
  for (const { kind, id, state } of body.leases)
    leases.push({ kind, id, status: await handlers[kind](db, deps, member, { id, state }, now) });
  return { leases };
}
