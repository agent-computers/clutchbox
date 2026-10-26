// Generated from the route manifest in @agent-computers/web (src/route-manifest.ts) by its
// generate-routes script. Change the manifest and regenerate rather than editing this file.
import { joinPage } from '@agent-computers/web/routes/join';
import { getServices } from '@/deployment/server';

export const dynamic = 'force-dynamic';

export { metadata } from '@agent-computers/web/routes/join';
export default joinPage(getServices);
