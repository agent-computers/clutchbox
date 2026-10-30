// Generated from the route manifest in @clutchbox/web (src/route-manifest.ts) by its
// generate-routes script. Change the manifest and regenerate rather than editing this file.
import { signInPage } from '@clutchbox/web/routes/sign-in';
import { pageApi } from '@/deployment/server';

export { metadata } from '@clutchbox/web/routes/sign-in';
export default signInPage(pageApi);
