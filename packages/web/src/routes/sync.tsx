import type { Metadata } from 'next';
import { BrowserSync } from '../components/browser-sync';
import { extensionDownloadUrl, extensionDownloadVersion } from '../lib/extension-download';
import { siteOrigin } from '../lib/site';

export const metadata: Metadata = { title: 'Browser sync · Clutchbox' };
export default function SyncPage() {
  return (
    <BrowserSync
      accountUrl={`${siteOrigin}/app/sync`}
      extensionVersion={extensionDownloadVersion}
      extensionDownloadUrl={extensionDownloadUrl}
    />
  );
}
