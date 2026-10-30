import { serverProofPath } from '@clutchbox/capture';
import { apiOrigin } from '@clutchbox/server/config';
import { type GetServices, unavailable } from '../services';

// /.well-known/*: the auth server's discovery documents, and the file naming this server's origin, which the verified
// list's CI check reads, and its API's, which the CLI connects agents to.
export const wellKnownRoute = (getServices: GetServices) =>
  async function GET(request: Request) {
    try {
      const { auth, config } = await getServices();
      if (new URL(request.url).pathname === serverProofPath)
        return Response.json(
          { origin: new URL(config.BETTER_AUTH_URL).origin, api: apiOrigin(config) },
          { headers: { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' } },
        );
      const response = await auth.handler(request);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    } catch (error) {
      return unavailable('auth', error);
    }
  };
