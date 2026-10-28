import { liveViewHandler } from '@clutchbox/api/live-view';
import { type GetServices, unavailable } from '../services';

// /api/v1/live-view: its own route, not the API's, for its own maxDuration, LIVE_VIEW_MAX_DURATION_MS
// (@clutchbox/server/computer-timing), which the route manifest gives its route file. The connection lasts until
// the relay closes it, just before that limit, and the page reconnects.
export const liveViewRoute = (getServices: GetServices) =>
  async function GET(request: Request) {
    try {
      const { db, auth, config, computers, hooks } = await getServices();
      return await liveViewHandler({ db, auth, origin: config.BETTER_AUTH_URL, computers, hooks })(request);
    } catch (error) {
      return unavailable('live view', error);
    }
  };
