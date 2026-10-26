// Generated from the route manifest in @agent-computers/web (src/route-manifest.ts) by its
// generate-routes script. Change the manifest and regenerate rather than editing this file.
import { settingsPage } from '@agent-computers/web/routes/settings';
import { getServices } from '@/deployment/server';

export { metadata } from '@agent-computers/web/routes/settings';
export default settingsPage(getServices);
