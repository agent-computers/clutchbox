import type { NextConfig } from 'next';

export declare const transpilePackages: string[];
export declare const securityHeaders: { key: string; value: string }[];
export declare function extensionDownloadEnv(
  appDir: string,
  extensionPackage: string,
): { EXTENSION_DOWNLOAD_VERSION: string; EXTENSION_DOWNLOAD_URL: string };
declare const config: NextConfig;
export default config;
