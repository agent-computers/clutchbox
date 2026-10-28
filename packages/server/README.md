# @clutchbox/server

The web app's server: accounts, browser sync, captures, computers, MCP grants, and live view, on Postgres.

## Data conventions

- Every table has an integer `id` primary key, and a TypeID `public_id` only when rows are referenced outside the server.
- `timestamps()` gives `created_at`, and `updated_at` where rows change. Lifecycle is nullable `*_at` columns, not booleans.
- States are `text` with a CHECK constraint built from one `as const` list, not Postgres enums.
- Every foreign key column is indexed.
- App data lives in app tables keyed by `membership_id` (a person in one organization), or by `user_id` only for what belongs to the person in every organization, never on Better Auth's tables. Organizations and memberships are app tables the auth adapter sees through its own Drizzle definitions, with Better Auth's `id` as the row's `public_id`, so app columns and integer keys stay out of its reach.
- `bun run db:generate --name <change>` writes the migration. It must work with the code already deployed: a destructive change expands in one release and contracts in a later one, and an applied migration is never edited.
