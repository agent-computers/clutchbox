// Generated from the route manifest in @clutchbox/web (src/route-manifest.ts) by its
// generate-routes script. Change the manifest and regenerate rather than editing this file.
import { consentPage } from '@clutchbox/web/routes/consent';
import { getServices } from '@/deployment/server';

export const dynamic = 'force-dynamic';

export { metadata } from '@clutchbox/web/routes/consent';
export default consentPage(getServices);
