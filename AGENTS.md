# Agent instructions

## Repo

- Clutchbox, under Apache-2.0. Every package builds, tests, and runs on its own, without any hosted service. Each package says what it is in its README or the root table; keep that current.
- Everything here is public, history included. Commit only synthetic data: no credentials, captured cookies or profiles, customer data, or internal plans, and no links to documents or issues outside this repository.
- Run `bun run format` before committing; `bun run lint`, `bun run typecheck`, and `bun run test` must pass. Fix a lint finding rather than suppressing it; a `biome-ignore` comment says why the rule is wrong for that line.
- Bump the extension (`apps/extension/package.json`) when extension or capture code changes, and the CLI (`packages/cli/package.json`) when what it bundles changes (`packages/cli/src`, `packages/server/src/agents.ts`). Schemes are in CONTRIBUTING.md; a push to main publishes the CLI to npm.

## Server

- The product reaches a deployment's own layers (metering, limits, operator admin and other Better Auth plugins, a provider account) only through `ServerHooks` (`packages/server/src/hooks.ts`) and the UI deployment (`packages/web/src/deployment.tsx`), passed in by each app's `deployment/`. Keep the no-op defaults working: they are what `apps/web` runs.
- Lean on Better Auth for anything auth-shaped (sign-in, sessions, OAuth, organizations, members, invitations, roles, API keys): its plugins and Better Auth UI, unless there is a clear reason not to, stated in a comment where our code takes over.
- Shape tables and migrations by `packages/server/README.md`, Data conventions.
- Give every API route and server service an integration test (Vitest, in process, with PGlite and real Better Auth) covering session, origin, validation, status codes, ownership, and failure paths, in the same change. Migrate one PGlite template per file in `beforeAll` and give each test `await template.clone()`. Unit-test only dense pure logic; test behavior, not configuration, constants, snapshots, or display-only UI.
- Keep timings for computers, computer sessions, and MCP tool calls in `packages/server/src/computer-timing.ts`, and the E2B adapter's command timings in `packages/e2b/src/timing.ts`. Each gets a comment saying what it bounds and how its value was chosen; derive related values from each other.
- Existing computers never get a new template. Put a file computers need in `HELPERS` (`packages/e2b/src/index.ts`), and Chrome's flags in `ENSURE_CHROME`, so the refresh on `computer_open` delivers it. A change to installed packages or the OS reaches only new computers (existing ones by a reset), so say so in the commit.

## Web and extension

- Build UI from the shadcn components in `packages/ui` (see its README, including the extension's copies).
- Fetch and change data with TanStack Query (`useQuery`, `useMutation`); queries live in `packages/web/src/lib/api.ts`.
- Add or change a product route only in the route manifest (`packages/web/src/route-manifest.ts`), then run `bun run generate-routes`. Next.js reads segment config only as literals in the route file, so the generated files carry them and CI's `--check` fails when one differs.
- Signed-in pages live under `/app`, in its sidebar layout; the root holds sign-in and consent. When a page's address changes, redirect the old one in `moved` and update `productMatcher` (both in `packages/web/src/proxy.ts`) and each app's hand-copied `proxy.ts` matcher, since installed extensions and connected agents link to it.
- Keep config and control out of the extension, so changes don't need a release: new tunables, lists, and settings are server data the extension clamps and falls back from, and a web app may only narrow what is captured. Add extension code only for what must run in Chrome.
