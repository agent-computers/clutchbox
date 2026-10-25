import type { UiDeployment } from '@agent-computers/web/deployment';

// This app's UI: no analytics, and no shell extras, so the signed-in app shows only the product's own pages and
// offers only the manual build of the extension, which this app builds for its own origin.
export const deployment: UiDeployment = { Analytics: () => null, shell: {} };
