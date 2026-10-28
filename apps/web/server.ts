import { migrate } from '@clutchbox/server/migrate';
import { startNodeServer } from '@clutchbox/web/node-server';

// The app's production server: the product's Node server (@clutchbox/web/node-server), with the product's
// migration for MIGRATE_ON_START=true. Run after `next build`: `node --import tsx server.ts`.
await startNodeServer({ dir: import.meta.dirname, migrate });
