// The manual build this deployment offers, as the app's next.config.ts sets it: its version, and where to download it,
// a GitHub release in production. Without a URL, the version's zip under the app's public/downloads.
export const extensionDownloadVersion = process.env.EXTENSION_DOWNLOAD_VERSION ?? '';
export const extensionDownloadUrl =
  process.env.EXTENSION_DOWNLOAD_URL || `/downloads/agent-computers-extension-${extensionDownloadVersion}.zip`;
