# Contributing

Thanks for helping. Bug reports, site compatibility reports, and new provider adapters are especially welcome.

## Setup

You need [Bun](https://bun.sh) and Node 24.

```sh
bun install
bunx playwright-core install chromium   # for the Playwright adapter's tests
bun run lint && bun run typecheck && bun run test
```

Run `bun run format` before committing. `bun run dev:extension` starts the extension in a development build.

## Guidelines

- **Never commit real browser data.** Tests use synthetic cookies only; no captured cookies, profiles, or credentials.
- **Keep packages standalone.** Every package builds, tests, and runs without any hosted service.
- **Version the extension** as `YY.MDD.PATCH` (`26.1016.0` is the first release on October 16, 2026) and bump `apps/extension/package.json` when extension or capture code changes. CI checks it.
- **Adding a provider?** Implement [`ComputerProvider`](packages/computer) in `packages/<provider>`, following [`packages/e2b`](packages/e2b), and add it to the README's package table.

## Reporting a site that doesn't stay signed in

Open an issue with the site, what the agent saw (signed out, a bot check, an error), and roughly how long after syncing. Don't include cookie values.
