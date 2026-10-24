import type { Distribution } from './controller';

// Chrome Web Store builds (`zip:store`) update through Chrome and offer added sites only; manual builds update from the
// server's account page and also offer Allow all sites.
export const distribution: Distribution = import.meta.env.MODE === 'store' ? 'store' : 'manual';
export const allSitesOffered = distribution === 'manual';
