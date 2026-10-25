import { createMcpEndpoint } from '@agent-computers/api/mcp';
import { type GetServices, unavailable } from '../services';

// /api/mcp. The route manifest gives its route file ROUTE_MAX_DURATION_MS (@agent-computers/server/computer-timing).
export const mcpRoute = (getServices: GetServices) =>
  async function handler(request: Request) {
    try {
      const { db, auth, config, computers, hooks } = await getServices();
      return await createMcpEndpoint({ db, auth, origin: config.BETTER_AUTH_URL, computers, hooks })(request);
    } catch (error) {
      return unavailable('mcp', error);
    }
  };
