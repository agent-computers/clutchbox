import { Pool } from 'pg';
import { migrationTarget, reportMigrationFailure, runMigrations } from './migrator';

// `node --import tsx packages/server/src/migrate.ts`: applies pending migrations to the database the environment names.
const target = migrationTarget();
if ('error' in target) {
  console.error(target.error);
  process.exit(1);
}
const pool = new Pool({ connectionString: target.connectionString, max: 1, connectionTimeoutMillis: 10_000 });
try {
  const client = await pool.connect();
  try {
    await runMigrations({ client, dataClass: target.dataClass });
    console.log(`Migrations applied successfully (${target.dataClass}).`);
  } finally {
    client.release();
  }
} catch (error) {
  reportMigrationFailure(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
