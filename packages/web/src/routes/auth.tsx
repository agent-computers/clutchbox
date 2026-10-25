import { extensionCors, tokenPreflight } from '@agent-computers/api';
import { type GetServices, unavailable } from '../services';

// /api/auth/*. The extension reaches only the token endpoint from its origin; extensionCors answers it there alone.
// Extension origins stay out of trustedOrigins: Better Auth checks Origin only on requests with a cookie, and the
// extension sends none.
export const authRoute = (getServices: GetServices) =>
  async function handler(request: Request) {
    try {
      const { auth } = await getServices();
      const response = await auth.handler(request);
      response.headers.set('Cache-Control', 'no-store');
      return extensionCors(request, response);
    } catch (error) {
      return extensionCors(request, unavailable('auth', error));
    }
  };
export const authPreflight = async (request: Request) => tokenPreflight(request);
