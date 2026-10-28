# @clutchbox/capture

The capture format and the sync contract shared by the extension, servers, and agents, as [zod](https://zod.dev) schemas with their TypeScript types.

- **`captureSchema`:** a versioned snapshot of the authorized sites' cookies, with full metadata (host-only, `SameSite`, partition key, expiry), its scope (sites and exclusions), and when it was taken.
- **`settingsSchema`, `syncSettingsSchema`:** which sites sync, excluded domains, and pause.
- **Sites:** `siteOfInput`, `siteOfUrl`, and `siteOfCookie` reduce an address or cookie domain to its site (an approximate registrable domain), and `captureDigest` fingerprints a capture so unchanged ones are not uploaded again.
- **OAuth:** `pkce`, `authorizeUrl`, `requestTokens`, and `readRedirect` for the extension's sign-in to its server.
- **Routes:** the request and response schemas of `/api/v1/me`, `/captures`, `/sync`, and `/sync/adopt`, so any server can implement them ([`packages/api`](../api) does).
