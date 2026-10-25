<div align="center">
  <a href="https://www.agent-computers.com">
    <img src=".github/assets/banner.png" alt="Agent Computers: agents that work signed in. Sync the sites you choose from your browser into the browsers your agents use." width="100%">
  </a>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-0d060b?style=flat" alt="Apache-2.0 license"></a>
    <a href="https://github.com/agent-computers/agent-computers/actions/workflows/ci.yml"><img src="https://github.com/agent-computers/agent-computers/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://github.com/agent-computers/agent-computers/releases/latest"><img src="https://img.shields.io/github/v/release/agent-computers/agent-computers?style=flat&color=0d060b&label=release" alt="Latest release"></a>
  </p>

  <p>
    <a href="https://www.agent-computers.com">Website</a>
    ·
    <a href="https://chromewebstore.google.com/detail/agent-computers-%E2%80%94-browser/bjmfpnkjkdkfimdfgbgepmdgdnodpmmi">Chrome extension</a>
    ·
    <a href="apps/server">Self-host</a>
    ·
    <a href="SECURITY.md">Security</a>
    ·
    <a href="https://github.com/agent-computers/agent-computers/issues">Issues</a>
  </p>
</div>

**Agent Computers syncs your browser's sign-ins to your AI agents.** A Chrome extension captures the sites you choose and keeps them current in the background, one way. Your agent's browser (Playwright, browser-use, Stagehand, an E2B sandbox, or any Chrome over CDP) then starts signed in instead of blank. No passwords typed, no 2FA prompts, and no signing in again in every sandbox.

Everything here is Apache-2.0: the extension, the capture format, the apply runtime, the provider adapters, and a self-host server. Run all of it yourself, or use the hosted service at [agent-computers.com](https://www.agent-computers.com).

## Why

Most of what people want agents to do happens behind a sign-in: email, calendars, shopping, dashboards, internal tools. Many of those sites have no API, and the ones that do rarely cover everything. Agents usually work around this in one of three ways:

- They type your password, which hands your credentials to the agent and stops at the first 2FA prompt or bot check.
- You sign in again inside each provider's cloud browser, once per site and once per provider.
- You export a cookie file once, and it goes stale within days.

Agent Computers keeps a live, consented copy of the sessions you already have, and applies it to whichever browser your agent uses.

## How it works

```mermaid
flowchart LR
  A["Your Chrome<br/>(extension)"] -- "sites you chose,<br/>one way" --> B["Sync server<br/>(self-host or hosted)"]
  B -- "latest capture" --> C["Apply runtime"]
  C --> D["Playwright"]
  C --> E["browser-use, Stagehand<br/>(CDP URL)"]
  C --> F["E2B computers"]
```

1. **Capture.** The extension reads cookies only for the sites you add, each behind its own Chrome permission, and skips the domains you exclude. It uploads a new capture when something changes.
2. **Store.** The server keeps the latest capture encrypted at rest and serves it to agents that hold your API key.
3. **Apply.** The apply runtime compares the new capture with the last one it applied and writes only what changed into the agent's browser. It clears the sites you signed out of and leaves every other site alone.

Nothing flows back: an agent's actions never change your own browser.

## Quickstart

### Hosted

Install the [Chrome extension](https://chromewebstore.google.com/detail/agent-computers-%E2%80%94-browser/bjmfpnkjkdkfimdfgbgepmdgdnodpmmi), choose the sites to sync, and connect Claude, ChatGPT, or Codex at [agent-computers.com](https://www.agent-computers.com). Your agents get a cloud Linux desktop with Chrome that is already signed in, with live view and takeover.

### Self-hosted, with Playwright

Run the [self-host server](apps/server), build the extension for it, and connect your browser. Then, in your agent:

```sh
npm install @agent-computers/playwright playwright
```

```ts
import { applyCapture, fetchCapture } from '@agent-computers/playwright';
import { chromium } from 'playwright';

const browser = await chromium.launch();
const context = await browser.newContext();

const capture = await fetchCapture({ server: 'https://sync.example.com', apiKey: process.env.API_KEY! });
if (capture) await applyCapture(context, capture);

const page = await context.newPage();
await page.goto('https://github.com'); // signed in
```

### browser-use, Stagehand, and other agents that take a CDP URL

Start Chrome with remote debugging, apply the capture to its default context, and give your agent the same URL:

```ts
const chrome = await chromium.connectOverCDP('http://localhost:9222');
await applyCapture(chrome.contexts()[0]!, capture);
```

```python
import asyncio
from browser_use import Agent, Browser, ChatOpenAI

agent = Agent(
    task="Find my last order on amazon.com",
    llm=ChatOpenAI(model="gpt-4.1-mini"),
    browser=Browser(cdp_url="http://localhost:9222"),
)
asyncio.run(agent.run())
```

### Any Chrome, without Playwright

[`@agent-computers/apply`](packages/apply) works from a raw CDP connection: `applyCookies(send, { clearSites, cookies })`.

## Packages

| Package | What it does |
| --- | --- |
| [`apps/extension`](apps/extension) | The Chrome extension (Manifest V3) that captures the sites you authorize and syncs them to your server. |
| [`apps/server`](apps/server) | A self-host sync server for one owner: the extension's sign-in and sync routes, and the latest capture for agents. |
| [`packages/playwright`](packages/playwright) | Applies a capture to a Playwright browser context, a persistent context, or a Chrome attached over CDP. |
| [`packages/apply`](packages/apply) | Works out what a capture changes since the last one applied, and applies it to any Chrome over CDP. |
| [`packages/capture`](packages/capture) | The capture format and sync contract: cookies with full metadata, sites, exclusions, and settings. |
| [`packages/computer`](packages/computer) | The interface an agent computer provider implements: create, pause, resume, screenshot, act, exec, and CDP. |
| [`packages/e2b`](packages/e2b) | Agent computers on [E2B](https://e2b.dev): a Linux desktop sandbox with Chrome, kept signed in. |
| [`packages/ui`](packages/ui) | The web app's design system: shadcn components on Base UI, the theme, and the fonts. |

Planned: adapters for Daytona, Browserbase, and Kernel.

## Security model

Syncing sessions is sensitive, so the defaults are narrow and the code is open for you to audit.

<img src="apps/extension/store/screenshot-2-control.png" alt="The extension's popup: you choose what syncs. Only the sites you add, each with its own Chrome permission; remove one, exclude domains, pause, or disconnect to delete the uploaded copy." width="640">

- **Opt-in per site.** No host permissions at install. Each site you add asks Chrome for its own permission, and only those sites' cookies are read. Capturing every site takes an explicit **Allow all sites**, which only builds outside the Chrome Web Store offer. Excluded domains are never captured.
- **One way.** Captures flow from your browser to your agents, never back.
- **You stay in control.** Pause, remove a site, or disconnect from the extension at any time. Disconnecting deletes everything that browser uploaded.
- **Encrypted at rest.** The self-host server seals captures with AES-256-GCM and keeps only hashes of tokens. Browsers connect with OAuth and PKCE, access tokens last five minutes, and a replayed refresh token disconnects that browser.
- **Cookies, not passwords.** Your passwords and 2FA secrets never leave your browser.
- **Honest limits.** Whoever runs the server and the agent's browser can use the synced sessions; treat the API key like a password. Device-bound sessions (Chrome's DBSC) don't carry over, and some sites sign out a copied session.

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## How it compares

| | Agent Computers | Cloud browser profiles (Browserbase contexts, Kernel profiles) | Exported cookie files | Giving the agent your password |
| --- | --- | --- | --- | --- |
| Uses the sessions you already have | ✅ | Sign in again in their browser | ✅ | Agent signs in |
| Stays current | Syncs in the background | Until the session expires | One-off snapshot | Per sign-in |
| Works across providers | Any Chrome over CDP | That provider | By hand | ✅ |
| Password reaches the agent | No | Typed into their browser | No | Yes |
| Consent and revoke | Per site, one click | Per profile | None | Change your password |
| Open source | ✅ Apache-2.0 | Varies | n/a | n/a |

## Self-hosted or hosted

| | Self-hosted (this repository) | Hosted ([agent-computers.com](https://www.agent-computers.com)) |
| --- | --- | --- |
| Extension | Build it for your server, or force-install it with Chrome Enterprise policy | Listed on the Chrome Web Store |
| Sync server | One owner, one file of encrypted state | Multi-user, managed |
| Agent browsers | Yours: Playwright, browser-use, E2B, any CDP | Hosted Linux desktops with Chrome, live view, and MCP for Claude, ChatGPT, and Codex |

## FAQ

### How do I give an AI agent my logged-in sessions?

Install the extension, add the sites the agent needs, and apply the latest capture to the agent's browser with [`@agent-computers/playwright`](packages/playwright) or [`@agent-computers/apply`](packages/apply). The agent's browser starts signed in, and later applies write only what changed.

### Does it work with browser-use, Stagehand, or Playwright MCP?

Yes, with any agent that drives Chrome through Playwright or attaches to it by CDP URL. Apply the capture to that Chrome's default context, then hand the agent the same CDP URL.

### Which sites work?

Most sites that keep you signed in with cookies. Sites that bind sessions to your device (Chrome's Device Bound Session Credentials), or that reject a session used from a new place, may sign the agent out. Sync again before each task to keep sessions fresh.

### Does my password leave my browser?

No. Only the cookies of the sites you chose are captured. Passwords, passkeys, and 2FA secrets stay in your browser.

### Can I run it entirely on my own infrastructure?

Yes. The [self-host server](apps/server), the extension, and the adapters run without any service of ours. Build the extension for your server's address and load it, or force-install it across your company.

## Contributing

Issues and pull requests are welcome. To work on the repo:

```sh
bun install
bun run lint && bun run typecheck && bun run test
```

The Playwright adapter's tests drive a real Chromium (`bunx playwright-core install chromium`). See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE). The Agent Computers name and logos are covered by the [trademark policy](TRADEMARKS.md): use them to say what's true, and rename a modified extension before publishing it.
