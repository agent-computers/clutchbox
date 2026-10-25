import { extensionClientMetadata } from '@agent-computers/server/browsers';

// /oauth/extension-client.json: the extension's OAuth client metadata. The server registers the client itself from the
// same values (ensureExtensionClient), so this document is for reference, not discovery.
export function GET() {
  return Response.json(extensionClientMetadata(process.env.EXTENSION_ORIGINS), {
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
