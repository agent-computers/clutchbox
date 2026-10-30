import { readFileSync } from 'node:fs';
import path from 'node:path';

// The product's base Next.js config, which each app's next.config.ts spreads and extends (its own transpiled packages
// and env). Plain JavaScript, so loading it needs no type stripping.
export const transpilePackages = [
  '@clutchbox/api',
  '@clutchbox/server',
  '@clutchbox/apply',
  '@clutchbox/capture',
  '@clutchbox/computer',
  '@clutchbox/e2b',
  '@clutchbox/ui',
  '@clutchbox/web',
];

// Every response's security headers, the API server's too (src/api-server.ts).
export const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

// The manual build of the extension an app offers, as the env the product library reads it from
// (src/lib/extension-download.ts): what scripts/build-extension-download.ts recorded in the app's directory during
// `build`, or without a record, as in development, the extension's current version (from extensionPackage, relative to
// the app) under the app's public/downloads. The app's next.config.ts sets it for the web app, and its api.ts for the
// API server.
export function extensionDownloadEnv(appDir, extensionPackage) {
  const readJson = file => JSON.parse(readFileSync(path.join(appDir, file), 'utf8'));
  let record = { version: readJson(extensionPackage).version, url: '' };
  try {
    record = readJson('.extension-download.json');
  } catch {}
  return { EXTENSION_DOWNLOAD_VERSION: record.version, EXTENSION_DOWNLOAD_URL: record.url };
}

/** @type {import('next').NextConfig} */
const config = {
  agentRules: false,
  poweredByHeader: false,
  transpilePackages,
  serverExternalPackages: ['pg'],
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
};
export default config;
