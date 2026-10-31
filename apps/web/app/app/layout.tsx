// Generated from the route manifest in @clutchbox/web (src/route-manifest.ts) by its
// generate-routes script. Change the manifest and regenerate rather than editing this file.
import { appLayout } from '@clutchbox/web/routes/app-layout';
import { pageApi } from '@/deployment/pages';
import { deployment } from '@/deployment/ui';

export const dynamic = 'force-dynamic';

export { metadata } from '@clutchbox/web/routes/app-layout';
export default appLayout(pageApi, deployment.shell);
