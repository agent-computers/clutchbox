import 'server-only';
import { type ApiExtension, createApi } from '@agent-computers/api';
import { createAuth } from '@agent-computers/server/auth';
import { ensureExtensionClient } from '@agent-computers/server/browsers';
import { readConfig } from '@agent-computers/server/config';
import { assertDatabaseEnvironment, createDatabase } from '@agent-computers/server/database';
import type { ServerHooks } from '@agent-computers/server/hooks';
import { logError } from '@agent-computers/server/log';
import { providerFromConfig } from '@agent-computers/server/provider';
import { extensionDownloadVersion } from './lib/extension-download';

export type ServicesOptions = {
  // The deployment's own API routes, mounted after the API's shared middleware.
  extendApi?: ApiExtension;
};

function buildServices(hooks: ServerHooks, { extendApi }: ServicesOptions) {
  const config = readConfig();
  const { db, pool } = createDatabase(config.DATABASE_URL);
  const auth = createAuth(db, config, {
    operatorAdmin: hooks.operatorAdmin,
    authPlugins: hooks.authPlugins,
    tenancy: hooks.tenancy,
    limits: hooks.limits,
  });
  // The provider account's computers, or else the deployment's own from its config.
  const computers = hooks.providerAccount(config) ?? providerFromConfig(config);
  return {
    config,
    db,
    pool,
    auth,
    computers,
    hooks,
    api: createApi({
      db,
      auth,
      origin: config.BETTER_AUTH_URL,
      computers,
      hooks,
      extensionVersion: extensionDownloadVersion,
      ...(extendApi && { extend: extendApi }),
    }),
  };
}
export type Services = ReturnType<typeof buildServices>;
export type GetServices = () => Promise<Services>;

// A deployment's services, built from its hooks on first use: each app passes its own (the no-op defaults, or a
// deployment's layers) and hands the returned getServices to the routes. The environment check, and writing the
// extension's OAuth client from EXTENSION_ORIGINS, run once per instance; a failure is retried on the next request.
export function createServices(hooks: ServerHooks, options: ServicesOptions = {}): GetServices {
  let services: Services | undefined;
  let checked: Promise<void> | undefined;
  return async () => {
    services ??= buildServices(hooks, options);
    const { db, config } = services;
    checked ??= assertDatabaseEnvironment(db, config.APP_ENV)
      .then(() => ensureExtensionClient(db, process.env.EXTENSION_ORIGINS))
      .catch(error => {
        checked = undefined;
        throw error;
      });
    await checked;
    return services;
  };
}

export function unavailable(scope: string, error: unknown) {
  logError(scope, error);
  return Response.json({ error: 'service_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
}
