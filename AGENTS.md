# Coding instructions

- This is Agent Computers, under Apache-2.0. Every package must build, test, and run on its own, without any hosted service.
- Everything here is public, including history. Never commit credentials, captured cookies or profiles, customer data, or internal plans, and don't link to documents or issues outside this repository.
- Each package states what it is in its own README or the root table; keep it current when a package is added or changes status.
- Run `bun run format` before committing; `bun run lint`, `bun run typecheck`, and `bun run test` must pass. Fix a lint finding rather than suppressing it; when a rule is wrong for a line, use a `biome-ignore` comment that says why.
- Version the extension as `YY.MDD.PATCH`: `26.1016.0` is the first release on October 16, 2026 (January 1 is `101`), and PATCH counts up for later releases that day, restarting at 0 the next day. Chrome accepts it as a manifest version. Bump `apps/extension/package.json` whenever extension or capture code changes; CI's `check:extension-version` enforces it.
- Web UI uses the shadcn components (Base UI), theme, and fonts in `packages/ui`; add a missing component there with the shadcn CLI (see its README) rather than writing one.
- The extension keeps its own copies of the shadcn components it uses and a trimmed theme (`apps/extension/src/ui`) for now. Copy a shadcn component in when the extension needs one, rather than writing one, and change shared colours and fonts in both.
