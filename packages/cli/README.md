# clutchbox

Connects your AI agents to Clutchbox from a terminal, so they work in a browser that's already signed in as you.

```sh
npx clutchbox@latest
```

It adds the Clutchbox MCP server to Claude Code (in every project) and Codex if they are installed, skipping one already connected, then opens setup in your browser: sign in, add the Chrome extension, and choose the sites to sync. If Chrome on this machine doesn't have the extension, it also opens the extension's Chrome Web Store page in Chrome (for the hosted service only; a self-hosted server's setup offers the build it accepts). It only reads Chrome's profile files to tell, skips the check over SSH or without a display, and keeps the usual steps whenever it can't tell. It holds no credentials. Each agent asks you to allow its own connection, as when you follow the Agents page by hand. Claude and ChatGPT on the web connect from that page.

| Option | |
| --- | --- |
| `--server <url>` | A self-hosted Clutchbox server. The default is the hosted service at `https://www.clutchbox.dev`. |
| `--agent` | For an AI agent running this for you: no questions, and the steps only you can do printed for it to pass on. Without a terminal, this is the default. |
| `-y`, `--yes` | Don't ask before changing your agents' settings. |

To have your agent do it, paste this into Claude Code or Codex:

> Set up Clutchbox so you can work in a cloud browser signed in as me. Run `npx -y clutchbox@latest --agent`, then tell me the steps only I can do: signing in, adding the Chrome extension, and allowing the connection.

## Develop

`bun run build` bundles `src` into `dist/clutchbox.js`, with no runtime dependencies. The commands it runs come from `@clutchbox/server/agents`, which the Agents page shows too. A change to either needs a version bump in `package.json` (CI's `check:cli-version`), and the push to main that brings a new version publishes it to npm (`publish-cli.yml`).
