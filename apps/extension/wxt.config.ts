import { browserOrigins, serverOrigins } from '@agent-computers/capture';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';
import { serverOriginOf } from './src/origin';

const server = serverOriginOf(process.env.WXT_SERVER_ORIGIN);

// Pinned public key: extension ID jpkiadcbmdldnjmfdllbiioieajicacg, which the server allows in EXTENSION_ORIGINS.
// Store uploads (`zip:store`) leave it out: the Chrome Web Store assigns the ID and rejects a `key` on upload.
const key =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnUE5ttvYs5K6gUFk0bEwkns7uXwxYx29c0bGz/Ny+cVTFuV582plnnAYzhn/SHB3DXpKmGTGeVuJcQmVzaxWh6NU/jtl7+VFzTbV+eHgrcsb0+9t0tGiHHfu7c6D0NnOL2DK2M6spAeBkZmMH4ug6H0n/ytrV5HpAn6Hv6wtaIR9vciwBvqtjP5/5Wwk9BcMcEy5KswM+HGqbMUfyV1B+e0O3+a9PdiBZz8KMa/yuwvNr9ieVcjfDncxLNdrazsNgr1E4RdoTaLK3aQywsMnLSgWdeYMN8d0upPqOJ4y16yIAJPtUa6O9kJL2BEs4n7N7AjnGCdOg+C5xu9TPwMRCQIDAQAB';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  zip: { artifactTemplate: 'agent-computers-{{version}}-{{browser}}.zip' },
  vite: () => ({ plugins: [tailwindcss()] }),
  // A function so WXT has loaded .env files into process.env first.
  manifest: ({ mode }) => ({
    name: 'Clutchbox — Browser Sync',
    description:
      'Sync sign-ins for sites you choose into the browsers your agents use. Opt-in, encrypted, with exclusions, pause, and disconnect.',
    ...(mode === 'store' ? {} : { key }),
    minimum_chrome_version: '130',
    // activeTab: opening the popup lets it read the current tab's address for Add this site.
    permissions: ['cookies', 'storage', 'alarms', 'activeTab'],
    // No host permissions at install: the extension reaches its server with OAuth tokens, and each site is
    // granted when added.
    optional_host_permissions: [...browserOrigins],
    // The OAuth redirect page, which the server's redirect opens. The navigation's initiator is the server, or the
    // identity provider the person signed in with mid-connect, and a connection can be on any HTTPS server, so any
    // HTTPS page may open it; it only finishes a flow this extension started (controller.ts, exchange).
    web_accessible_resources: [{ resources: ['connected.html'], matches: [...serverOrigins(server), 'https://*/*'] }],
    incognito: 'not_allowed',
    // Connections reach their servers over HTTPS, and the build's own server, which may be on HTTP on this machine.
    content_security_policy: {
      extension_pages: `script-src 'self'; object-src 'none'; connect-src ${server} https:`,
    },
    // Chrome Enterprise policy: `approvedServers` connect without the warning (README.md, Connecting to another server).
    storage: { managed_schema: 'managed-schema.json' },
  }),
});
