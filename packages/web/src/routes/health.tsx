import { assertDatabaseEnvironment } from '@agent-computers/server/database';
import { type GetServices, unavailable } from '../services';

// /api/health.
export const healthRoute = (getServices: GetServices) =>
  async function GET() {
    try {
      // Checks the database on every call; getServices only checks once per instance.
      const { db, config } = await getServices();
      await assertDatabaseEnvironment(db, config.APP_ENV);
      return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return unavailable('health', error);
    }
  };
