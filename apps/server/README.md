# Self-host server

A minimal server for the Agent Computers extension, for one owner. It receives the extension's encrypted uploads and serves the latest capture to your agents, which apply it with [`@agent-computers/playwright`](../../packages/playwright) or [`@agent-computers/apply`](../../packages/apply). There are no accounts, dashboard, or billing: browsers connect with an access key, and agents read with an API key.

## Run it

1. Generate the secrets:

   ```sh
   openssl rand -base64 32   # CAPTURE_ENCRYPTION_KEY
   openssl rand -hex 24      # ACCESS_KEY, entered when a browser connects
   openssl rand -hex 24      # API_KEY, for agents
   ```

2. Build the extension for your server, then load `apps/extension/.output/chrome-mv3` unpacked from `chrome://extensions` (Developer mode):

   ```sh
   WXT_SERVER_ORIGIN=https://sync.example.com bun run build:extension
   ```

   An unpacked build keeps the extension ID `jpkiadcbmdldnjmfdllbiioieajicacg`. To force-install it across a company with Chrome Enterprise policy, pack it with your own key and use that ID instead.

3. Start the server behind HTTPS (a reverse proxy is fine) with `bun install` and `bun run --cwd apps/server start`:

   | Variable | |
   | --- | --- |
   | `PUBLIC_URL` | The origin the extension was built for, such as `https://sync.example.com`. HTTPS, except on localhost. |
   | `EXTENSION_ORIGINS` | `chrome-extension://<id>` of each build allowed to connect, comma separated. |
   | `ACCESS_KEY` | Entered on the connect page; at least 16 characters. |
   | `API_KEY` | Bearer key for `GET /api/v1/capture`; at least 16 characters. |
   | `CAPTURE_ENCRYPTION_KEY` | 32 bytes, base64. Seals the stored capture and settings. |
   | `OWNER_EMAIL` | The account the extension shows. Defaults to `owner@localhost`. |
   | `DATA_DIR` | Where `state.json` lives. Defaults to `./data`. |
   | `PORT` | Defaults to `8787`. |

4. In the extension, add the sites to sync and connect. The connect page asks for the access key.

## What it stores

One file, `DATA_DIR/state.json`, rewritten whole after each change. The capture and the sync settings are sealed with AES-256-GCM under `CAPTURE_ENCRYPTION_KEY`; tokens are kept only as hashes. Access tokens last five minutes, and refresh tokens rotate and expire after 30 days unused. A rotated refresh token replayed after 30 seconds counts as stolen: that browser is disconnected and what it uploaded is deleted. Disconnecting from the extension does the same.

## For agents

`GET /api/v1/capture` with `Authorization: Bearer <API_KEY>` answers `{ digest, completedAt, capture }`, or 404 before the first upload. Anyone with the API key can sign in as you on the synced sites; keep it with the agent's other secrets.
