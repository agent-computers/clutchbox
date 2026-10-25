import 'server-only';
import { defaultServerHooks } from '@agent-computers/server/hooks';
import { createServices } from '@agent-computers/web/services';

// This app's services: the product's defaults, with no allowance and no operator admin, and computers from the
// organization's own E2B_API_KEY. A deployment that adds its own layers passes its hooks and API routes here instead.
export const getServices = createServices(defaultServerHooks);
