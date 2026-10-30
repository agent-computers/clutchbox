import 'server-only';
import { type ApiExtension, createApi } from '@clutchbox/api';
import { createAuth } from '@clutchbox/server/auth';
import { ensureExtensionClient } from '@clutchbox/server/browsers';
import { readConfig, signInMethods } from '@clutchbox/server/config';
import { assertDatabaseEnvironment, createDatabase } from '@clutchbox/server/database';
import type { ServerHooks } from '@clutchbox/server/hooks';
import { logError } from '@clutchbox/server/log';
import { providerFromConfig } from '@clutchbox/server/provider';
import { extensionDownloadVersion } from './lib/extension-download';
import type { PageApi } from './lib/page-api';

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
  // The deployment's computers, from its config; an organization on its own account gets its own (hooks.providerAccount).
  const computers = providerFromConfig(config);
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
      signInMethods: signInMethods(config),
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

// The pages' way to the API (lib/page-api.ts) when it runs in this process: the deployment's own, with no network hop.
export function inProcessApi(getServices: GetServices): PageApi {
  return async (path, init) => {
    const { api, config } = await getServices();
    return api.fetch(new Request(new URL(path, config.BETTER_AUTH_URL), init));
  };
}

export function unavailable(scope: string, error: unknown) {
  logError(scope, error);
  return Response.json({ error: 'service_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
}
