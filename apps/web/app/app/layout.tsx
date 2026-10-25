// Generated from the route manifest in @agent-computers/web (src/route-manifest.ts) by its
// generate-routes script. Change the manifest and regenerate rather than editing this file.
import { appLayout } from '@agent-computers/web/routes/app-layout';
import { getServices } from '@/deployment/server';
import { deployment } from '@/deployment/ui';

export const dynamic = 'force-dynamic';

export { metadata } from '@agent-computers/web/routes/app-layout';
export default appLayout(getServices, deployment.shell);
