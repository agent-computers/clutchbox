import base, { extensionDownloadEnv } from '@clutchbox/web/next-config.mjs';
import type { NextConfig } from 'next';

// The manual build of the extension this app offers, built for this app's origin during `build` and served from
// public/downloads; in development, the extension's current version.
const config: NextConfig = {
  ...base,
  env: extensionDownloadEnv(import.meta.dirname, '../extension/package.json'),
};
export default config;
