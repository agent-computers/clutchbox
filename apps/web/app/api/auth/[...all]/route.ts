// Generated from the route manifest in @clutchbox/web (src/route-manifest.ts) by its
// generate-routes script. Change the manifest and regenerate rather than editing this file.
import { authPreflight, authRoute } from '@clutchbox/web/routes/auth';
import { getServices } from '@/deployment/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handler = authRoute(getServices);

export { authPreflight as OPTIONS, handler as GET, handler as POST };
