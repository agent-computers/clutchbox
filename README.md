<div align="center">
  <a href="https://www.clutchbox.dev">
    <img src="brand/readme-banner.png" alt="Clutchbox: your agents, already signed in. Sync your sign-ins to where your agents run." width="100%">
  </a>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-0d060b?style=flat" alt="Apache-2.0 license"></a>
    <a href="https://github.com/clutchbox-hq/clutchbox/actions/workflows/ci.yml"><img src="https://github.com/clutchbox-hq/clutchbox/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://github.com/clutchbox-hq/clutchbox/releases/latest"><img src="https://img.shields.io/github/v/release/clutchbox-hq/clutchbox?style=flat&color=0d060b&label=release" alt="Latest release"></a>
  </p>

  <p>
    <a href="https://www.clutchbox.dev">Website</a>
    ·
    <a href="https://chromewebstore.google.com/detail/agent-computers-%E2%80%94-browser/bjmfpnkjkdkfimdfgbgepmdgdnodpmmi">Chrome extension</a>
    ·
    <a href="#self-hosted-the-whole-product-for-your-organization">Self-host</a>
    ·
    <a href="SECURITY.md">Security</a>
    ·
    <a href="https://github.com/clutchbox-hq/clutchbox/issues">Issues</a>
  </p>
</div>

**Sync your sign-ins to where your agents run.** A Chrome extension captures the sites you choose and keeps them current in the background, one way. Your agent's browser (Playwright, browser-use, Stagehand, an E2B sandbox, or any Chrome over CDP) then starts signed in instead of blank. No passwords typed, no 2FA prompts, and no signing in again in every sandbox.

Everything here is Apache-2.0: the extension, the capture format, the apply runtime, the provider adapters, and the whole web app for one organization, with sign-in, browser sync, computers for agents with live view and takeover, and the MCP server agents connect to. Run all of it yourself, or use the hosted service at [clutchbox.dev](https://www.clutchbox.dev).

## Why

Most of what people want agents to do happens behind a sign-in: email, calendars, shopping, dashboards, internal tools. Many of those sites have no API, and the ones that do rarely cover everything. Agents usually work around this in one of three ways:

- They type your password, which hands your credentials to the agent and stops at the first 2FA prompt or bot check.
- You sign in again inside each provider's cloud browser, once per site and once per provider.
- You export a cookie file once, and it goes stale within days.

Clutchbox keeps a live, consented copy of the sessions you already have, and applies it to whichever browser your agent uses.

## How it works

```mermaid
flowchart LR
  A["Your Chrome<br/>(extension)"] -- "sites you chose,<br/>one way" --> B["Web app<br/>(self-hosted or hosted)"]
  B -- "latest capture" --> C["Apply runtime"]
  C --> D["Playwright"]
  C --> E["browser-use, Stagehand<br/>(CDP URL)"]
  C --> F["E2B computers"]
```

1. **Capture.** The extension reads cookies only for the sites you add, each behind its own Chrome permission, and skips the domains you exclude. It uploads a new capture when something changes.
2. **Store.** The server keeps the latest capture encrypted at rest and serves it only to the agents you connect.
3. **Apply.** The apply runtime compares the new capture with the last one it applied and writes only what changed into the agent's browser. It clears the sites you signed out of and leaves every other site alone.

Nothing flows back: an agent's actions never change your own browser.

## Quickstart

### Hosted

Install the [Chrome extension](https://chromewebstore.google.com/detail/agent-computers-%E2%80%94-browser/bjmfpnkjkdkfimdfgbgepmdgdnodpmmi), choose the sites to sync, and connect Claude, ChatGPT, or Codex at [clutchbox.dev](https://www.clutchbox.dev). Your agents get a cloud Linux desktop with Chrome that is already signed in, with live view and takeover.

### Self-hosted: the whole product for your organization

[`apps/web`](apps/web) is the product the hosted service runs, for one organization: sign-in with Google, GitHub, your identity provider over OIDC, or email links, browser sync, a computer per member on your own [E2B](https://e2b.dev) team with live view and takeover, and the MCP server Claude, ChatGPT, and Codex connect to. It has no allowance or billing: every member's computer time runs on your E2B account.

You need Docker with Compose, Chrome, and an [E2B API key](https://e2b.dev/dashboard?tab=keys). Computers start from the template we publish on E2B, so there is nothing to build there.

1. Clone the repository and write `.env` beside [`compose.yaml`](compose.yaml), with two new secrets, your E2B key, and email links caught by the bundled [Mailpit](https://mailpit.axllent.org):

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

2. Start it. Compose builds the app, starts Postgres beside it, and the app applies migrations before it serves <http://localhost:3000>:

   ```sh
   docker compose up --build
   ```

3. Sign in at <http://localhost:3000> with your email address; the link arrives in Mailpit at <http://localhost:8025>.

4. Connect your browser. The Browser sync page offers the manual build of the extension, made for this app's origin: unzip it, load it unpacked from `chrome://extensions` (Developer mode), choose the sites to sync, and connect.

5. Connect an agent to `http://localhost:3000/api/mcp`; the Agents page has the steps for each. Claude Code, on the same machine, takes `claude mcp add --transport http clutchbox http://localhost:3000/api/mcp`. Then ask it to open your computer: it starts signed in to the sites you sync.

Claude, ChatGPT, and other agents that run in the cloud need the app on a public HTTPS origin. On a server, set these in `.env` too, then run `docker compose up -d --build` again:

| Variable | |
| --- | --- |
| `BETTER_AUTH_URL` | The app's public origin, such as `https://agents.example.com`. The image builds the extension download for it, so rebuild after changing it. |
| `APP_ENV` | `production`, which requires HTTPS and `E2B_API_KEY`. |
| `TRUST_PROXY` | `true`. Compose serves the app only on this machine, at `127.0.0.1:3000` (or `PORT`): put an HTTPS reverse proxy in front of it that overwrites `X-Forwarded-For` with the client's address, never appends to it. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in: an OAuth web client with `<BETTER_AUTH_URL>/api/auth/callback/google` as its redirect URI. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in: an OAuth app with `<BETTER_AUTH_URL>/api/auth/callback/github` as its callback URL. GitHub must have verified the email address it shares for the member. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_NAME` | Company SSO (Okta, Entra ID, Keycloak, Authentik, and others): the issuer URL, or its discovery document's, and a confidential client with `<BETTER_AUTH_URL>/api/auth/callback/oidc` as its redirect URI. The provider's ID token must carry `email` and `email_verified: true`. `OIDC_NAME` names the button, such as `Acme SSO`. |
| `SMTP_URL`, `SMTP_FROM` | Email links from your mail server: an `smtp://` or `smtps://` URL with its credentials, such as `smtps://user:password@smtp.example.com`, and the address the links come from. Remove the Mailpit ones unless you want email links caught on the server. |
| `EXTENSION_ORIGINS` | Leave unset for the manual build, pinned to `chrome-extension://jpkiadcbmdldnjmfdllbiioieajicacg`, and the Chrome Web Store build, `chrome-extension://bjmfpnkjkdkfimdfgbgepmdgdnodpmmi`. To use only your own build, pack it with your own key and list its ID, comma separated. |

[`apps/web/.env.example`](apps/web/.env.example) describes every variable. Compose sets `DATABASE_URL` to its own Postgres, whose data is kept in the `postgres` volume; back it up with `docker compose exec postgres pg_dump -U agent_computers agent_computers`, and keep `CAPTURE_ENCRYPTION_KEY` apart from it, since it decrypts the synced captures.

Set at least one sign-in method; the app refuses to start without one, or with one only partly set. The sign-in page offers each one you set. An email address has one account, whichever way it signs in: a sign-in with another provider joins the account its address already has when that provider has verified the address, and an email link proves the address itself. Your identity provider is trusted to verify addresses, so it can sign in to any account with an address it vouches for. Members connect and remove providers on the Settings page, keeping at least one way to sign in. Members can install the Chrome Web Store extension and connect it to your app's address from its setup tab (**Connect to another server**), or load the manual build their own app offers, which connects to it without asking. The store extension warns before connecting to a server outside the [verified list](apps/extension#connecting-to-another-server); approve yours for your company with Chrome Enterprise policy, or ask to have it listed. The usage table and the MCP tools' free-minutes fields are there for a metering hook: without one, nothing writes or shows them.

#### Your own computer template

The published template, `agent-computers-desktop`, is built from this repository's main branch and rebuilt weekly for current Chrome; computers bring its helper scripts to your checkout's version when they open. To run your own instead, build it into your E2B team. E2B finds a template by name in your own team first, so new computers then start from yours:

```sh
bun install
E2B_API_KEY=e2b_your_key bun run computer:template
```

To build and use another name, set `E2B_COMPUTER_TEMPLATE` for both. Existing computers keep the template they started from until you reset them on the Computer page.

#### Without Docker

With [Bun](https://bun.sh), Node 24, and your own Postgres: `bun install`, copy [`apps/web/.env.example`](apps/web/.env.example) to `.env.local` beside it and fill it in, `DATABASE_URL` included, load it into your shell (`set -a; . ./.env.local; set +a` there), then, from the repository root, `bun run build:web` and `MIGRATE_ON_START=true bun run start:web` (`HOST` and `PORT` choose the address; default `0.0.0.0:3000`). For development, run `bun run db:migrate` and then `bun run dev:web`, and build the extension yourself with `WXT_SERVER_ORIGIN=http://localhost:3000 bun run build:extension` and load `apps/extension/.output/chrome-mv3`; live view needs the built server.

### Your own browser: Playwright, browser-use, and Stagehand

[`@agent-computers/playwright`](packages/playwright) applies a capture to any Chromium that Playwright drives, including a Chrome that browser-use or Stagehand attach to by CDP URL; [`@agent-computers/apply`](packages/apply) does the same over a raw CDP connection. Your servers read a member's latest capture from the web app over REST with an organization API key, which owners and admins create on the Organization page (see the [Playwright adapter](packages/playwright#readme)). Agents connected over MCP get synced sign-ins on the web app's computers instead, whose Chrome they can also drive over CDP.

To link your own users to members, register your app under **Connect apps** on the Organization page and send people to `/api/auth/oauth2/authorize` with `scope=openid connect`, PKCE (S256), a `state`, and optionally your `external_user_id` for them. They sign in or sign up, join your organization, connect the extension, and approve. Exchange the code at `/api/auth/oauth2/token` with your client ID and secret (HTTP Basic): the response carries `member`, the ID to pass to `fetchCapture`, and your `external_user_id`. `GET /api/v1/connections` with an API key lists every link. Removing the member or deleting the app ends it.

## Packages

| Package | What it does |
| --- | --- |
| [`apps/extension`](apps/extension) | The Chrome extension (Manifest V3) that captures the sites you authorize and syncs them to your server. |
| [`apps/web`](apps/web) | The web app for one organization: the dashboard, sign-in, the API, and MCP, with the product's defaults. [`Dockerfile`](Dockerfile) and [`compose.yaml`](compose.yaml) run it with Postgres. |
| [`packages/playwright`](packages/playwright) | Applies a capture to a Playwright browser context, a persistent context, or a Chrome attached over CDP. |
| [`packages/apply`](packages/apply) | Works out what a capture changes since the last one applied, and applies it to any Chrome over CDP. |
| [`packages/capture`](packages/capture) | The capture format and sync contract: cookies with full metadata, sites, exclusions, and settings. |
| [`packages/computer`](packages/computer) | The interface a computer provider implements: create, pause, resume, screenshot, act, exec, and CDP. |
| [`packages/e2b`](packages/e2b) | Computers for agents on [E2B](https://e2b.dev): a Linux desktop sandbox with Chrome, kept signed in. |
| [`packages/ui`](packages/ui) | The web app's design system: shadcn components on Base UI, the theme, and the fonts. |
| [`packages/server`](packages/server) | The web app's server: accounts, browser sync, captures, computers, MCP grants, and live view, on Postgres with its migrations. |
| [`packages/api`](packages/api) | The web app's HTTP API: the routes the web app and extension call, the MCP server agents connect to, and the live-view relay. |
| [`packages/web`](packages/web) | The web app's product library: the dashboard, sign-in and consent pages, their route manifest, the proxy, and the Node server. |

Planned: adapters for Daytona, Browserbase, and Kernel.

## Extending the web app

The product takes a deployment's own layers as parameters, never as imports, so you can add yours without forking it. [`apps/web`](apps/web) passes the defaults in two files:

- **Server hooks**, in [`apps/web/deployment/server.ts`](apps/web/deployment/server.ts): `createServices(hooks, { extendApi })` builds the services every route uses. `ServerHooks` ([`packages/server/src/hooks.ts`](packages/server/src/hooks.ts)) has `metering`, an allowance checked before a computer starts or keeps running and charged for its running time; `operatorAdmin`, Better Auth plugins for operators and a record of each member's activity; and `providerAccount`, computers on a provider account other than `E2B_API_KEY`'s. The defaults are no-ops: no allowance, no operator admin, and computers from your E2B config. `extendApi` adds API routes after the API's shared session, origin, and header handling.
- **The UI deployment**, in [`apps/web/deployment/ui.ts`](apps/web/deployment/ui.ts): `UiDeployment` ([`packages/web/src/deployment.tsx`](packages/web/src/deployment.tsx)) has an `Analytics` component rendered on every page, and shell extras, as plain data: sidebar pages with an optional badge, footer links, where the wordmark goes, and a store listing to offer instead of the manual build.

Product routes come from the route manifest ([`packages/web/src/route-manifest.ts`](packages/web/src/route-manifest.ts)). `bun run generate-routes` writes each one as a thin file in the app's `app/`, wired to its own `deployment/`, and CI fails when they differ. Add your own pages beside them.

## Security model

Syncing sessions is sensitive, so the defaults are narrow and the code is open for you to audit.

<img src="brand/chrome-web-store/screenshot-2-control.png" alt="The extension's popup: you choose what syncs. Only the sites you add, each with its own Chrome permission; remove one, exclude domains, pause, or disconnect to delete the uploaded copy." width="640">

- **Opt-in per site.** No host permissions at install. Each site you add asks Chrome for its own permission, and only those sites' cookies are read. Capturing every site takes an explicit **Allow all sites**, which only builds outside the Chrome Web Store offer. Excluded domains are never captured.
- **One way.** Captures flow from your browser to your agents, never back.
- **Warned before another server.** The store extension connects to a server other than clutchbox.dev only after a full-page warning, unless the server is on the [verified list](apps/extension#connecting-to-another-server) or your administrator approved it.
- **You stay in control.** Pause, remove a site, or disconnect from the extension at any time. Disconnecting deletes everything that browser uploaded.
- **Encrypted at rest.** The web app seals captures with AES-256-GCM under `CAPTURE_ENCRYPTION_KEY`, a key kept outside the database, and keeps only hashes of tokens. Browsers connect with OAuth and PKCE, access tokens last five minutes, and a replayed refresh token disconnects that browser.
- **Cookies, not passwords.** Your passwords and 2FA secrets never leave your browser.
- **Honest limits.** Whoever runs the server and the agent's browser can use the synced sessions, so connect only agents you trust. Device-bound sessions (Chrome's DBSC) don't carry over, and some sites sign out a copied session.

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## How it compares

| | Clutchbox | Cloud browser profiles (Browserbase contexts, Kernel profiles) | Exported cookie files | Giving the agent your password |
| --- | --- | --- | --- | --- |
| Uses the sessions you already have | ✅ | Sign in again in their browser | ✅ | Agent signs in |
| Stays current | Syncs in the background | Until the session expires | One-off snapshot | Per sign-in |
| Works across providers | Any Chrome over CDP | That provider | By hand | ✅ |
| Password reaches the agent | No | Typed into their browser | No | Yes |
| Consent and revoke | Per site, one click | Per profile | None | Change your password |
| Open source | ✅ Apache-2.0 | Varies | n/a | n/a |

## Self-hosted or hosted

| | Self-hosted (this repository) | Hosted ([clutchbox.dev](https://www.clutchbox.dev)) |
| --- | --- | --- |
| Extension | The manual build your server offers or you build for it, loaded unpacked or force-installed with Chrome Enterprise policy | Listed on the Chrome Web Store |
| Server | The web app for your organization, with Docker Compose or on your own Node and Postgres | Multi-user, managed |
| Agent browsers | Linux desktops with Chrome on your E2B team, with live view and MCP | Hosted Linux desktops with Chrome, live view, and MCP for Claude, ChatGPT, and Codex |

## FAQ

### How do I give an AI agent my logged-in sessions?

Install the extension, add the sites the agent needs, and connect the agent to the web app's MCP server. The agent's computer starts signed in to those sites, and later syncs write only what changed.

### Does it work with browser-use, Stagehand, or Playwright MCP?

Agents connected over MCP can drive their computer's Chrome over CDP. For your own Chrome, the adapters apply a capture to its default context, and you hand the agent the same CDP URL; read the latest capture for them over REST with an organization API key (`fetchCapture` in the [Playwright adapter](packages/playwright#readme)).

### Which sites work?

Most sites that keep you signed in with cookies. Sites that bind sessions to your device (Chrome's Device Bound Session Credentials), or that reject a session used from a new place, may sign the agent out. Sync again before each task to keep sessions fresh.

### Does my password leave my browser?

No. Only the cookies of the sites you chose are captured. Passwords, passkeys, and 2FA secrets stay in your browser.

### Can I run it entirely on my own infrastructure?

Yes. The [web app](#self-hosted-the-whole-product-for-your-organization), the extension, and the adapters run without any service of ours. Computers run on your E2B team, from the template we publish there unless you [build your own](#your-own-computer-template). Load the manual build of the extension your server offers or you build for it, or force-install it across your company.

## Contributing

Issues and pull requests are welcome. To work on the repo:

```sh
bun install
bun run lint && bun run typecheck && bun run test
```

The Playwright adapter's tests drive a real Chromium (`bunx playwright-core install chromium`); the web app's tests run on in-process PGlite, with no Postgres to set up. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE). The Clutchbox name and logos are covered by the [trademark policy](TRADEMARKS.md): use them to say what's true, and rename a modified extension before publishing it.
