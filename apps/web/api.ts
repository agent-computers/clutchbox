import { extensionDownloadEnv } from '@clutchbox/web/next-config.mjs';

// The app's API on its own (@clutchbox/web/api-server), apart from its pages: what compose.yaml's api service runs, as
// `node --conditions=react-server --import tsx api.ts`, with the same configuration as server.ts. The extension
// version it offers comes from the same record next.config.ts reads, set before the services load it.
Object.assign(process.env, extensionDownloadEnv(import.meta.dirname, '../extension/package.json'));
const { migrate } = await import('@clutchbox/server/migrate');
const { startApiServer } = await import('@clutchbox/web/api-server');
const { getServices } = await import('./deployment/server');
await startApiServer({ getServices, migrate });
