import * as authSchema from './auth-schema';
import * as schema from './schema';

// Every table and relation a Drizzle client knows: the app's (schema.ts, where migrations come from) and Better Auth's
// view of the organization tables (auth-schema.ts), which its adapter's joins query. The views come last, so the
// relations of a table both define are theirs.
export const databaseSchema = { ...schema, ...authSchema };
