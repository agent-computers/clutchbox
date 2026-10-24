import { serverOriginOf } from './origin';

export const serverOrigin = serverOriginOf(import.meta.env.WXT_SERVER_ORIGIN as string | undefined);
