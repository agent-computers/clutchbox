# Agent Computers browser extension

The Chrome extension (Manifest V3) that keeps your agents signed in to the sites you choose. It captures those sites' cookies with their full metadata and syncs them, one way, to your server: the [web app](../web) when you self-host, or [agent-computers.com](https://www.agent-computers.com) from the [Chrome Web Store](https://chromewebstore.google.com/detail/agent-computers-%E2%80%94-browser/bjmfpnkjkdkfimdfgbgepmdgdnodpmmi).

<img src="store/screenshot-2-control.png" alt="The extension's popup: github.com synced, with Sync now, Pause, Remove this site, and Add another site." width="640">

- **Only the sites you add,** each behind its own Chrome permission; it requests no host permissions at install. Builds outside the Chrome Web Store also offer **Allow all sites**, as an explicit choice.
- **Excluded domains** are never captured, even under Allow all sites.
- **Pause, remove a site, or disconnect** at any time. Disconnecting deletes what this browser uploaded.
- **Several organizations,** on one server, each connected on its own: its own sites, exclusions, pause, and disconnect. A site goes only to the organizations you add it to.
- **Uploads only on change,** in the background while Chrome runs, over OAuth with PKCE and short-lived tokens.

Works in Chrome 130 and later, and in other Chromium browsers (Edge, Brave, Arc).

## Build it for your server

A self-hosted web app's Browser sync page already offers this build, made for the app's origin. To build it yourself:

```sh
bun install
WXT_SERVER_ORIGIN=https://agents.example.com bun run build:extension
```

Load `apps/extension/.output/chrome-mv3` unpacked from `chrome://extensions` (Developer mode), or pack it with your own key and force-install it with Chrome Enterprise policy. `bun run dev:extension` starts a development build that reloads on change.

## Verify the store build

Each [release](https://github.com/agent-computers/agent-computers/releases) carries the Chrome Web Store build, made by CI from the tagged commit, and the same workflow uploads that zip to the store. The build is reproducible from a clone of this repository, so you can check the listed extension against its source:

```sh
curl -sL -o store.crx 'https://clients2.google.com/service/update2/crx?response=redirect&prodversion=130&acceptformat=crx3&x=id%3Dbjmfpnkjkdkfimdfgbgepmdgdnodpmmi%26uc'
unzip -qo store.crx -d store   # warns about the CRX header before the zip; that's expected
version=$(node -p "require('./store/manifest.json').version")
git checkout "v$version" && bun install --frozen-lockfile && bun run --cwd apps/extension zip:store
unzip -qo "apps/extension/.output/agent-computers-$version-chrome.zip" -d built
diff -r -x _metadata built store
```

The only difference should be the `update_url` line the store adds to `manifest.json`; `_metadata` holds the store's signatures.

To publish a modified build, on a store or anywhere else, give it its own name and icons (`wxt.config.ts` and `public/icon`) and your own key: the Agent Computers name and icons mean this project's builds ([trademark policy](../../TRADEMARKS.md)).
