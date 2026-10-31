import 'server-only';
import { inProcessApi } from '@clutchbox/web/services';
import { getServices } from './server';

// The pages' way to the API: this app's own, in process.
export const pageApi = inProcessApi(getServices);
