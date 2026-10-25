import { extensionCors } from '@agent-computers/api';
import { type GetServices, unavailable } from '../services';

// /api/v1/*. The API answers CORS itself; a 503 from here needs it too, or the extension sees a network error instead.
export const apiRoute = (getServices: GetServices) =>
  async function handler(request: Request) {
    try {
      return await (await getServices()).api.fetch(request);
    } catch (error) {
      return extensionCors(request, unavailable('api', error));
    }
  };
