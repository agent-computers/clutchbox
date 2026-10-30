# Web app

The whole product, for one organization, as the hosted service at [clutchbox.dev](https://www.clutchbox.dev) runs it: sign-in with Google, GitHub, your identity provider over OIDC, or email links, browser sync, a computer per member on your own [E2B](https://e2b.dev) team with live view and takeover, and the MCP server Claude, ChatGPT, and Codex connect to. It has no credit or billing: every member's computer time runs on your E2B account.

## Run it

You need Docker with Compose, Chrome, and an [E2B API key](https://e2b.dev/dashboard?tab=keys). Computers start from the template we publish on E2B, so there is nothing to build there.

1. Clone the repository and write `.env` beside [`compose.yaml`](../../compose.yaml), with two new secrets, your E2B key, and email links caught by the bundled [Mailpit](https://mailpit.axllent.org):

   ```sh
   git clone https://github.com/clutchbox-hq/clutchbox && cd clutchbox
   cat > .env <<EOF
   BETTER_AUTH_SECRET=$(openssl rand -base64 32)
   CAPTURE_ENCRYPTION_KEY=$(openssl rand -base64 32)
   E2B_API_KEY=e2b_your_key
   SMTP_URL=smtp://mailpit:1025
   SMTP_FROM=agents@localhost
   EOF
   ```

2. Start it. Compose builds the web app and its API, starts Postgres beside them, and serves both at <http://localhost:3000> through Caddy, which sends the API's paths (`/api`, `/.well-known`, `/oauth`) to the API's container and the rest to the web app's. Each applies migrations before it starts:

   ```sh
   docker compose up --build
   ```

3. Sign in at <http://localhost:3000> with your email address; the link arrives in Mailpit at <http://localhost:8025>.

4. Connect your browser. The Browser sync page offers the manual build of the extension, made for this app's origin: unzip it, load it unpacked from `chrome://extensions` (Developer mode), choose the sites to sync, and connect.

5. Connect an agent to `http://localhost:3000/api/mcp`; the Agents page has the steps for each. Claude Code, on the same machine, takes `claude mcp add --transport http clutchbox http://localhost:3000/api/mcp`. Then ask it to open your computer: it starts signed in to the sites you sync.

## On a server

Claude, ChatGPT, and other agents that run in the cloud need the app on a public HTTPS origin. On a server, set these in `.env` too, then run `docker compose up -d --build` again:

| Variable | |
| --- | --- |
| `BETTER_AUTH_URL` | The app's public origin, such as `https://agents.example.com`. The image builds the extension download for it, so rebuild after changing it. |
| `APP_ENV` | `production`, which requires HTTPS and `E2B_API_KEY`. |
| `API_ORIGIN` | Leave unset to serve the API from `BETTER_AUTH_URL`. Set it to another origin that reaches the same server, such as `https://api.agents.example.com`, to give agents, developers' CDP clients, and live view their own host: the MCP URL, CDP URLs, and live view's socket use it, while sign-in and the extension stay on `BETTER_AUTH_URL`. Agents connected before a change reconnect. |
| `PORT` | Where Compose serves the app, only on this machine: `127.0.0.1:3000` by default. Put an HTTPS reverse proxy in front of it that overwrites `X-Forwarded-For` with the client's address, never appends to it: Caddy keeps the address a proxy on this machine sends, and the apps' rate limits key on it. |
| `CLIENT_IP_HEADER`, `FORWARDED_SECRET` | Off Compose, where the client's address comes from when a reverse proxy appends to `X-Forwarded-For`: a header your host's proxy sets and clients can't, such as Fly.io's `Fly-Client-IP`; and a secret another proxy forwarding through it, such as a rewrite from where the pages run, sends in `X-Forwarded-Secret` with the client's address first in `X-Forwarded-For`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in: an OAuth web client with `<BETTER_AUTH_URL>/api/auth/callback/google` as its redirect URI. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in: an OAuth app with `<BETTER_AUTH_URL>/api/auth/callback/github` as its callback URL. GitHub must have verified the email address it shares for the member. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_NAME` | Company SSO (Okta, Entra ID, Keycloak, Authentik, and others): the issuer URL, or its discovery document's, and a confidential client with `<BETTER_AUTH_URL>/api/auth/callback/oidc` as its redirect URI. The provider's ID token must carry `email` and `email_verified: true`. `OIDC_NAME` names the button, such as `Acme SSO`. |
| `SMTP_URL`, `SMTP_FROM` | Email links from your mail server: an `smtp://` or `smtps://` URL with its credentials, such as `smtps://user:password@smtp.example.com`, and the address the links come from. Remove the Mailpit ones unless you want email links caught on the server. |
| `AGENT_CLIENT_URLS` | Leave unset for Claude, Claude Code, ChatGPT, and Codex, the agents the server accepts by default. To let another MCP agent connect, list the `client_id` URL it sends (its client metadata document's), or a prefix of it ending with a slash, comma separated. Any site can publish a document that names itself after a known agent, so list only URLs on the agent vendor's own host. |
| `EXTENSION_ORIGINS` | Leave unset for the manual build, pinned to `chrome-extension://jpkiadcbmdldnjmfdllbiioieajicacg`, and the Chrome Web Store build, `chrome-extension://bjmfpnkjkdkfimdfgbgepmdgdnodpmmi`. To use only your own build, pack it with your own key and list its ID, comma separated. |

[`.env.example`](.env.example) describes every variable. Compose sets `DATABASE_URL` to its own Postgres, whose data is kept in the `postgres` volume; back it up with `docker compose exec postgres pg_dump -U agent_computers agent_computers`, and keep `CAPTURE_ENCRYPTION_KEY` apart from it, since it decrypts the synced captures.

## Sign-in and members

Set at least one sign-in method; the app refuses to start without one, or with one only partly set. The sign-in page offers each one you set. An email address has one account, whichever way it signs in: a sign-in with another provider joins the account its address already has when that provider has verified the address, and an email link proves the address itself. Your identity provider is trusted to verify addresses, so it can sign in to any account with an address it vouches for. Members connect and remove providers on the Settings page, keeping at least one way to sign in. Members can install the Chrome Web Store extension and connect it to your app's address from its setup tab (**Connect to another server**), or load the manual build their own app offers, which connects to it without asking. The store extension warns before connecting to a server outside the [verified list](../extension#signing-in-to-another-server); approve yours for your company with Chrome Enterprise policy, or ask to have it listed. The usage table and the MCP tools' free-minutes fields are there for a metering hook: without one, nothing writes or shows them.

## Your own computer template

The published template, `agent-computers-desktop`, is built from this repository's main branch and rebuilt weekly for current Chrome, once per computer size (`agent-computers-desktop-2x` and `-4x` for the larger ones); computers bring its helper scripts to your checkout's version when they open. To run your own instead, build it into your E2B team. E2B finds a template by name in your own team first, so new computers then start from yours:

```sh
bun install
E2B_API_KEY=e2b_your_key bun run computer:template
```

The build makes every size. To build and use another name, set `E2B_COMPUTER_TEMPLATE` for both. Existing computers keep the template they started from until you reset them, or change their size, on the Computer page.

## Without Docker

With [Bun](https://bun.sh), Node 24, and your own Postgres: `bun install`, copy [`apps/web/.env.example`](.env.example) to `.env.local` beside it and fill it in, `DATABASE_URL` included, load it into your shell (`set -a; . ./.env.local; set +a` there), then, from the repository root, `bun run build:web` and `MIGRATE_ON_START=true bun run start:web` (`HOST` and `PORT` choose the address; default `0.0.0.0:3000`). That serves the whole app, the API included. To run the API on its own as Compose does, `bun run start:api` on another `PORT` serves the API's paths without the pages, and needs no build; set `TRUST_PROXY=true` on both behind a proxy that routes those paths to it and overwrites `X-Forwarded-For`. For development, run `bun run db:migrate` and then `bun run dev:web`, and build the extension yourself with `WXT_SERVER_ORIGIN=http://localhost:3000 bun run build:extension` and load `apps/extension/.output/chrome-mv3`; live view needs the built server.

## Extending it

The product takes a deployment's own layers as parameters, never as imports, so you can add yours without forking it. This app passes the defaults in two files:

- **Server hooks**, in [`apps/web/deployment/server.ts`](deployment/server.ts): `createServices(hooks, { extendApi })` builds the services every route uses. `ServerHooks` ([`packages/server/src/hooks.ts`](../../packages/server/src/hooks.ts)) has `metering`, a credit checked before a computer starts or keeps running and charged for its running time, worded as it shows it; `limits`, how many members and running forks an organization may have and whether its developer API (API keys and Connect) refuses it; `operatorAdmin`, Better Auth plugins for operators and a record of each member's activity; `authPlugins`, a deployment's other Better Auth plugins, such as Stripe billing, whose tables the schema carries; and `providerAccount`, an organization's own provider account, such as an E2B team it brought, which then runs all of its computers instead of `E2B_API_KEY`'s. The defaults are no-ops: no credit, no limits beyond the product's, no operator admin, and computers from your E2B config. `extendApi` adds API routes after the API's shared session, origin, and header handling.
- **The UI deployment**, in [`apps/web/deployment/ui.ts`](deployment/ui.ts): `UiDeployment` ([`packages/web/src/deployment.tsx`](../../packages/web/src/deployment.tsx)) has an `Analytics` component rendered on every page, and shell extras, as plain data: sidebar pages with an optional badge, footer links, a landing page, and a store listing to offer instead of the manual build.

Product routes come from the route manifest ([`packages/web/src/route-manifest.ts`](../../packages/web/src/route-manifest.ts)). `bun run generate-routes` writes each one as a thin file in the app's `app/`, wired to its own `deployment/`, and CI fails when they differ. Add your own pages beside them.
