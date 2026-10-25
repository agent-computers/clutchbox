import { extensionDownloadUrl } from '../lib/extension-download';

// /downloads/agent-computers-extension.zip: a stable link to the manual build this deployment offers, its GitHub
// release asset in production, else the local zip, where a relative Location keeps the host the browser asked for.
export function GET() {
  return new Response(null, { status: 307, headers: { Location: extensionDownloadUrl } });
}
