// Generated from the route manifest in @agent-computers/web (src/route-manifest.ts) by its
// generate-routes script. Change the manifest and regenerate rather than editing this file.
import { wellKnownRoute } from '@agent-computers/web/routes/well-known';
import { getServices } from '@/deployment/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = wellKnownRoute(getServices);
