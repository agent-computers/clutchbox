// Generated from the route manifest in @agent-computers/web (src/route-manifest.ts) by its
// generate-routes script. Change the manifest and regenerate rather than editing this file.
import { mcpRoute } from '@agent-computers/web/routes/mcp';
import { getServices } from '@/deployment/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const handler = mcpRoute(getServices);

export { handler as POST, handler as GET, handler as DELETE };
