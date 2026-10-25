import { resolve } from 'node:path';
import { Pool } from 'pg';
import { migrationTarget, reportMigrationFailure, runMigrations } from './migrator';

// Applies pending migrations to the database the environment names. True when it applied; on failure it has said why,
// without credentials. The web app's Node server runs it with MIGRATE_ON_START=true, and so does
// `node --import tsx packages/server/src/migrate.ts`.
export async function migrate(): Promise<boolean> {
  const target = migrationTarget();
  if ('error' in target) {
    console.error(target.error);
    return false;
  }
  const pool = new Pool({ connectionString: target.connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const client = await pool.connect();
    try {
      await runMigrations({ client, dataClass: target.dataClass });
      console.log(`Migrations applied successfully (${target.dataClass}).`);
      return true;
    } finally {
      client.release();
    }
  } catch (error) {
    reportMigrationFailure(error);
    return false;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename && !(await migrate())) process.exitCode = 1;
