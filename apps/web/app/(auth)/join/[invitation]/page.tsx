// Generated from the route manifest in @clutchbox/web (src/route-manifest.ts) by its
// generate-routes script. Change the manifest and regenerate rather than editing this file.
import { invitationPage } from '@clutchbox/web/routes/join';
import { pageApi } from '@/deployment/server';

export const dynamic = 'force-dynamic';

export { metadata } from '@clutchbox/web/routes/join';
export default invitationPage(pageApi);
