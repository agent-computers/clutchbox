import { serve } from '@hono/node-server';
import { createApp } from './app';
import { readConfig } from './config';
import { fileStore } from './store';

const config = readConfig();
const app = createApp(config, await fileStore(config.DATA_DIR));
serve({ fetch: app.fetch, port: config.PORT }, ({ port }) =>
  console.log(`Agent Computers self-host server on port ${port}, serving ${config.PUBLIC_URL}`),
);
