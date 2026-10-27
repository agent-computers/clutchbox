import { cdpHandler } from '@agent-computers/api/cdp';
import { type GetServices, unavailable } from '../services';

// /api/v1/cdp: its own route, not the API's, for its own maxDuration, CDP_MAX_DURATION_MS
// (@agent-computers/server/computer-timing), which the route manifest gives its route file. The connection lasts until
// the proxy closes it, just before that limit, and the client reconnects.
export const cdpRoute = (getServices: GetServices) =>
  async function GET(request: Request) {
    try {
      const { db, computers, hooks } = await getServices();
      return await cdpHandler({ db, computers, hooks })(request);
    } catch (error) {
      return unavailable('cdp', error);
    }
  };
