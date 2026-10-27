# Contributing

Thanks for helping. Bug reports, site compatibility reports, and new provider adapters are especially welcome.

## Setup

You need [Bun](https://bun.sh) and Node 24.

```sh
bun install
bunx playwright-core install chromium   # for the Playwright adapter's tests
bun run lint && bun run typecheck && bun run test
```

The web app's tests run on in-process PGlite, so they need no Postgres. Before a pull request that touches the web app or its packages, also run:

```sh
bun run generate-routes --check   # the route files match the manifest
bun run db:generate --name missing_migration   # writes nothing when the schema has its migration
bun run build:web                 # with the variables in apps/web/.env.example set, as CI's placeholders do
```

Run `bun run format` before committing. `bun run dev:extension` starts the extension in a development build, and `bun run dev:web` the web app (see the [web app README](apps/web/README.md) for its configuration).

## Guidelines

- **Never commit real browser data.** Tests use synthetic cookies only; no captured cookies, profiles, or credentials.
- **Keep packages standalone.** Every package builds, tests, and runs without any hosted service.
- **Version the extension** as `YY.MDD.PATCH` (`26.1016.0` is the first release on October 16, 2026) and bump `apps/extension/package.json` when extension or capture code changes. CI checks it.
- **Adding a product route?** Add it to the route manifest (`packages/web/src/route-manifest.ts`) and run `bun run generate-routes`, rather than writing the route file.
- **Changing the schema?** Run `bun run db:generate --name <change>` and commit the SQL. A migration must work with the code already deployed, so a destructive change expands in one release and contracts in a later one.
- **Adding a provider?** Implement [`ComputerProvider`](packages/computer) in `packages/<provider>`, following [`packages/e2b`](packages/e2b), and add it to the README's package table.

## Reporting a site that doesn't stay signed in

Open an issue with the site, what the agent saw (signed out, a bot check, an error), and roughly how long after syncing. Don't include cookie values.
