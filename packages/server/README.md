# @clutchbox/server

The web app's server: accounts, browser sync, captures, computers, MCP grants, and live view, on Postgres.

## Data conventions

- Every table has an integer `id` primary key, and a TypeID `public_id` only when rows are referenced outside the server.
- `timestamps()` gives `created_at`, and `updated_at` where rows change. Lifecycle is nullable `*_at` columns, not booleans.
- States are `text` with a CHECK constraint built from one `as const` list, not Postgres enums.
- Every foreign key column is indexed.
- App data lives in app tables keyed by `membership_id` (a person in one organization), or by `user_id` only for what belongs to the person in every organization, never on Better Auth's tables. Organizations and memberships are app tables the auth adapter sees through its own Drizzle definitions, with Better Auth's `id` as the row's `public_id`, so app columns and integer keys stay out of its reach.
- Services own their queries, with no repository layer; Drizzle is the typed query layer, and transactions and row locks stay visible where the logic needs them.
- Normalize by default. Denormalize only to seal data together, keep state that changes together under one row lock, or fix a measured slow read; the copy names its source in a comment and both are written in one transaction. `jsonb` is for opaque or provider-shaped data, never values we filter on. Delete rows outright, never soft-delete.
- Times that drive logic come from the `now` a service is passed; database `now()` is only a `created_at` default.
- Only Better Auth's tables, and its views of ours, define Drizzle `relations()`; app queries use explicit joins.
- `bun run db:generate --name <change>` writes the migration, and an applied migration is never edited. Migrations run before new code serves, so each works with the code already deployed. To drop a column, first remove it from the schema with its generated `DROP` replaced by a no-op (Drizzle selects every column a table defines), then drop it in the next release with `db:generate --custom`.
