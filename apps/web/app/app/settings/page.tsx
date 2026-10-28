// Generated from the route manifest in @clutchbox/web (src/route-manifest.ts) by its
// generate-routes script. Change the manifest and regenerate rather than editing this file.
import { settingsPage } from '@clutchbox/web/routes/settings';
import { getServices } from '@/deployment/server';

export { metadata } from '@clutchbox/web/routes/settings';
export default settingsPage(getServices);
