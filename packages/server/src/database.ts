import 'server-only';
import { attachDatabasePool } from '@vercel/functions';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { dataClassFor, type ServerConfig } from './config';
import * as schema from './schema';
export type Database = NodePgDatabase<typeof schema>;
export function createDatabase(connectionString: string) {
  const vercel = Boolean(process.env.VERCEL);
  // On Vercel, each of many instances takes a share of the traffic; a Node server is one process that takes it all.
  const max = vercel ? 5 : 20;
  const pool = new Pool({ connectionString, max, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 10_000 });
  pool.on('error', () => {
    console.error('Database connection failure');
  });
  // Fluid Compute reuses instances: release idle clients before an instance suspends. A Node server never suspends,
  // so the idle timeout alone releases them.
  if (vercel) attachDatabasePool(pool);
  return { db: drizzle(pool, { schema }), pool };
}
export async function assertDatabaseEnvironment(db: Database, environment: ServerConfig['APP_ENV']) {
  const [record] = await db.select().from(schema.installation).where(eq(schema.installation.id, 'singleton'));
  if (record?.dataClass !== dataClassFor(environment))
    throw new Error('Database environment mismatch or migrations missing.');
}
