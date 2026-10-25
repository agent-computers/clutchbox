import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PoolClient } from 'pg';
import type { Database } from './database';
import { backfillMemberships, type Tenancy } from './organizations';
import * as schema from './schema';

export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

export type DataClass = 'production' | 'nonproduction';

// Where a migration command runs, from its environment, or why it may not.
export function migrationTarget(
  env: NodeJS.ProcessEnv = process.env,
): { connectionString: string; dataClass: DataClass } | { error: string } {
  const environment = env.APP_ENV;
  // A direct connection: the advisory lock below needs one session, which a transaction-mode pooler (Neon's, behind
  // Vercel's DATABASE_URL) does not keep. A plain Postgres, as self-hosted, serves DATABASE_URL directly.
  const connectionString = env.DATABASE_URL_UNPOOLED || (env.VERCEL ? undefined : env.DATABASE_URL);
  if (!['development', 'preview', 'production'].includes(environment ?? '') || !connectionString)
    return { error: 'Migration requires APP_ENV and DATABASE_URL_UNPOOLED (or, off Vercel, DATABASE_URL).' };
  if (env.VERCEL_ENV && env.VERCEL_ENV !== environment) return { error: 'Migration deployment environment mismatch.' };
  return { connectionString, dataClass: environment === 'production' ? 'production' : 'nonproduction' };
}

// Applies pending migrations on one session, under an advisory lock so concurrent deploys or replicas take turns, and
// records whether the database holds production data so the other kind of deployment refuses it. Then it puts accounts
// made before organizations into one, with the deployment's own tenancy (ServerHooks.tenancy): required, so a
// deployment cannot backfill with another's choice by leaving it out. `afterMigrate` runs
// on the same session before the lock is released, with every public table, so a deployment can grant its own roles
// access to exactly the tables the migrations left.
export async function runMigrations({
  client,
  dataClass,
  tenancy,
  afterMigrate,
}: {
  client: PoolClient;
  dataClass: DataClass;
  tenancy: Tenancy;
  afterMigrate?: (client: PoolClient, tables: string[]) => Promise<void>;
}): Promise<void> {
  await client.query("SELECT pg_advisory_lock(hashtext('agent-computers-migrations'))");
  try {
    // A migration waiting on locks held by live traffic fails fast instead of queueing requests behind it.
    await client.query("SET lock_timeout = '5s'");
    const exists = await client.query("SELECT to_regclass('public.installation') AS name");
    if (exists.rows[0]?.name) {
      const marker = await client.query("SELECT data_class FROM installation WHERE id = 'singleton'");
      if (marker.rows[0]?.data_class && marker.rows[0].data_class !== dataClass)
        throw new Error('environment mismatch');
    }
    await migrate(drizzle(client), { migrationsFolder });
    await client.query(
      "INSERT INTO installation (id, data_class) VALUES ('singleton', $1) ON CONFLICT (id) DO NOTHING",
      [dataClass],
    );
    await backfillMemberships(drizzle(client, { schema }) as unknown as Database, tenancy);
    if (afterMigrate) {
      const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map(
        row => row.tablename as string,
      );
      await afterMigrate(client, tables);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('agent-computers-migrations'))");
  }
}

// Logs what is safe to log about a failed migration: the Postgres error code, never the message, which can carry
// connection details.
export function reportMigrationFailure(error: unknown): void {
  const cause = error instanceof Error && error.cause ? error.cause : error;
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
  if (/^[A-Z0-9_]{5,32}$/.test(code)) console.error(`Migration error code: ${code}`);
  console.error(
    'Migration failed; verify connection, database environment, and migration permissions. Details suppressed to protect credentials.',
  );
}
