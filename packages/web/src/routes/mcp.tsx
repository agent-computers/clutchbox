import { createMcpEndpoint } from '@clutchbox/api/mcp';
import { apiOrigin } from '@clutchbox/server/config';
import { type GetServices, unavailable } from '../services';

// /api/mcp. The route manifest gives its route file ROUTE_MAX_DURATION_MS (@clutchbox/server/computer-timing).
export const mcpRoute = (getServices: GetServices) =>
  async function handler(request: Request) {
    try {
      const { db, auth, config, computers, hooks } = await getServices();
      return await createMcpEndpoint({
        db,
        auth,
        origin: config.BETTER_AUTH_URL,
        apiOrigin: apiOrigin(config),
        computers,
        hooks,
      })(request);
    } catch (error) {
      return unavailable('mcp', error);
    }
  };
