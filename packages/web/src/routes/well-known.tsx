import { type GetServices, unavailable } from '../services';

// /.well-known/*: the auth server's discovery documents.
export const wellKnownRoute = (getServices: GetServices) =>
  async function GET(request: Request) {
    try {
      const { auth } = await getServices();
      const response = await auth.handler(request);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    } catch (error) {
      return unavailable('auth', error);
    }
  };
