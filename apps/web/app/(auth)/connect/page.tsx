// Generated from the route manifest in @clutchbox/web (src/route-manifest.ts) by its
// generate-routes script. Change the manifest and regenerate rather than editing this file.
import { connectPage } from '@clutchbox/web/routes/connect';
import { pageApi } from '@/deployment/pages';

export const dynamic = 'force-dynamic';

export { metadata } from '@clutchbox/web/routes/connect';
export default connectPage(pageApi);
