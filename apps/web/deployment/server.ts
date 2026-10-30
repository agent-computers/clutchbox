import 'server-only';
import { defaultServerHooks } from '@clutchbox/server/hooks';
import { createServices, inProcessApi } from '@clutchbox/web/services';

// This app's services: the product's defaults, with no credit and no operator admin, and computers from the
// organization's own E2B_API_KEY. A deployment that adds its own layers passes its hooks and API routes here instead.
export const getServices = createServices(defaultServerHooks);
// The pages' way to the API: this app's own, in process.
export const pageApi = inProcessApi(getServices);
