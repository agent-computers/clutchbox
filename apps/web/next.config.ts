import { readFileSync } from 'node:fs';
import path from 'node:path';
import base from '@clutchbox/web/next-config.mjs';
import type { NextConfig } from 'next';

// The manual build of the extension this app offers, as scripts/build-extension-download.ts recorded it during
// `build`: built for this app's origin and served from public/downloads. Without a record, as in development, the
// extension's current version. The product library reads both only from this env.
const readJson = (file: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, file), 'utf8'));
let extensionDownload: { version: string; url: string } = {
  version: readJson('../extension/package.json').version,
  url: '',
};
try {
  extensionDownload = readJson('.extension-download.json');
} catch {}

const config: NextConfig = {
  ...base,
  env: { EXTENSION_DOWNLOAD_VERSION: extensionDownload.version, EXTENSION_DOWNLOAD_URL: extensionDownload.url },
};
export default config;
