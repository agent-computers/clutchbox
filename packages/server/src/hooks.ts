import 'server-only';
import type { ComputerProvider } from '@agent-computers/computer';
import type { BetterAuthPlugin } from 'better-auth';
import type { ServerConfig } from './config';
import type { Database } from './database';

// A deployment's own layers, such as the hosted service's, plug in here. The product calls metering, operator admin,
// and a per-organization provider account only through these hooks, and never imports their implementations: the
// deployment passes them in when it builds its services. The defaults are no-ops, so a deployment without them has
// no allowance and no operator admin, and its computers come from its own E2B config (providerFromConfig).

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

// A member's computer time against an allowance.
export type Usage = { usedSeconds: number; allowanceSeconds: number; remainingSeconds: number; resetsAt: Date };
// Why metering refuses to start or extend a computer's run: shown to agents and the page, with when it lifts.
export type MeteringRefusal = { message: string; resetsAt: Date };
export type Metering = {
  // The usage the account page and agents show; null without an allowance.
  usage(db: Database, userId: string, now: Date): Promise<Usage | null>;
  // Checked before a computer is created, woken, or used, and before live view extends its holds.
  refusal(db: Database, userId: string, now: Date): Promise<MeteringRefusal | null>;
  // Running time the computer service booked after the fact, inside the transaction that recorded it.
  charge(tx: Transaction, userId: string, seconds: number, now: Date): Promise<void>;
};
export const noMetering: Metering = {
  usage: async () => null,
  refusal: async () => null,
  charge: async () => {},
};

export type OperatorAdmin = {
  // Better Auth plugins for operators, and the paths of theirs that stay off.
  plugins: BetterAuthPlugin[];
  disabledPaths: string[];
  // A signed-in request by the user: app, agent, and live view use.
  recordActivity(db: Database, userId: string): Promise<void>;
};
export const noOperatorAdmin: OperatorAdmin = { plugins: [], disabledPaths: [], recordActivity: async () => {} };

export type ServerHooks = {
  metering: Metering;
  operatorAdmin: OperatorAdmin;
  // Computers on a provider account other than the deployment's; undefined falls back to providerFromConfig
  // (the deployment's E2B_API_KEY).
  providerAccount(config: ServerConfig): ComputerProvider | undefined;
};
export const defaultServerHooks: ServerHooks = {
  metering: noMetering,
  operatorAdmin: noOperatorAdmin,
  providerAccount: () => undefined,
};
