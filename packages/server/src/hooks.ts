import 'server-only';
import type { ComputerProvider, ComputerSize } from '@agent-computers/computer';
import type { BetterAuthPlugin } from 'better-auth';
import type { ServerConfig } from './config';
import type { Database } from './database';
import { type Member, singleOrganization, type Tenancy } from './organizations';

// A deployment's own layers, such as the hosted service's, plug in here. The product calls metering, limits, operator
// admin, a deployment's own Better Auth plugins, a per-organization provider account, and tenancy only through these hooks, and never imports their implementations:
// the deployment passes them in when it builds its services. The defaults are no-ops, so a deployment without them has
// no credit, no limits of its own, and no operator admin, its computers come from its own E2B config (providerFromConfig), and it serves
// one organization that everyone joins.

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

// A member's computer time this month against a credit. The hook decides what the credit covers: the member, or their
// whole organization, and words its amounts where they are shown.
export type Usage = {
  // What the month's computer time cost, the credit, and what is left of it, such as "$0.42".
  cost: string;
  credit: string;
  creditLeft: string;
  // The share of the credit used, from 0 to 1, for its bar.
  usedShare: number;
  resetsAt: Date;
  // Whether running past the credit is refused (true) or charged (false).
  hardStop: boolean;
  // The month's estimated charge so far, worded by the deployment, for those who may see it; absent otherwise.
  estimate?: string;
};
// Why metering refuses to start or extend a computer's run: shown to agents and the page, with when it lifts.
export type MeteringRefusal = { message: string; resetsAt: Date };
export type Metering = {
  // The usage the account page and agents show; null without a credit.
  usage(db: Database, member: Member, now: Date): Promise<Usage | null>;
  // Checked before a computer is created, woken, or used, and before live view extends its holds.
  refusal(db: Database, member: Member, now: Date): Promise<MeteringRefusal | null>;
  // Running time the computer service booked after the fact to the member's computer, at the size the computer runs
  // at (COMPUTER_SIZES), inside the transaction that recorded it, and how many times the computer paused in it, since a
  // provider may bill the snapshot it takes on each pause.
  charge(
    tx: Transaction,
    member: Member,
    seconds: number,
    now: Date,
    size: ComputerSize,
    pauses: number,
  ): Promise<void>;
  // A size's price per minute, worded by the deployment, such as "$0.0028", where it prices computer time.
  minutePrice?(size: ComputerSize): string;
};
export const noMetering: Metering = {
  usage: async () => null,
  refusal: async () => null,
  charge: async () => {},
};

// What a deployment allows an organization beyond the product's own limits, such as by its plan. Each answers null to
// leave the product's.
export type MemberLimit = { limit: number; message: string };
export type Limits = {
  // Members it may have, and what an invitation or join past them is told.
  members(db: Pick<Database, 'select'>, organizationId: string): Promise<MemberLimit | null>;
  // Forks that may run at once across its members, where organizations.max_running_forks is not set.
  runningForks(db: Pick<Database, 'select'>, organizationId: string): Promise<number | null>;
  // Why its developer API (organization API keys and joining through Connect) refuses it, shown to the caller.
  apiRefusal(db: Pick<Database, 'select'>, organizationId: string): Promise<string | null>;
};
export const noLimits: Limits = {
  members: async () => null,
  runningForks: async () => null,
  apiRefusal: async () => null,
};

export type OperatorAdmin = {
  // Better Auth plugins for operators, and the paths of theirs that stay off.
  plugins: BetterAuthPlugin[];
  disabledPaths: string[];
  // A signed-in request by the user: app, agent, and live view use.
  recordActivity(db: Database, userId: string): Promise<void>;
};
export const noOperatorAdmin: OperatorAdmin = { plugins: [], disabledPaths: [], recordActivity: async () => {} };

// Better Auth plugins a deployment adds beyond operator admin's, such as billing, built over its database, and the
// paths of theirs that stay off. Their tables must be in the product's schema (schema.ts), which carries those of the
// Stripe plugin.
export type AuthPlugins = { plugins: BetterAuthPlugin[]; disabledPaths: string[] };
export const noAuthPlugins = (_db: Database): AuthPlugins => ({ plugins: [], disabledPaths: [] });

export type ServerHooks = {
  metering: Metering;
  limits: Limits;
  operatorAdmin: OperatorAdmin;
  authPlugins(db: Database): AuthPlugins;
  // Computers on a provider account other than the deployment's; undefined falls back to providerFromConfig
  // (the deployment's E2B_API_KEY).
  providerAccount(config: ServerConfig): ComputerProvider | undefined;
  // Which organization a new account joins (organizations.ts). The migration runner takes the same choice for accounts
  // made before organizations, so a deployment passes it there too.
  tenancy: Tenancy;
};
export const defaultServerHooks: ServerHooks = {
  metering: noMetering,
  limits: noLimits,
  operatorAdmin: noOperatorAdmin,
  authPlugins: noAuthPlugins,
  providerAccount: () => undefined,
  tenancy: singleOrganization,
};
