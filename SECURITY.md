# Security

Agent Computers handles session cookies, which can sign in as you. We take reports seriously and credit reporters who want it.

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](https://github.com/agent-computers/agent-computers/security/advisories/new). Please don't open a public issue. Include what you found, how to reproduce it, and its impact. We'll confirm we received it, keep you updated as we fix it, and agree a disclosure date with you.

In scope: this repository's extension, capture format, apply runtime, adapters, and web app (`apps/web` and its packages `web`, `server`, and `api`), the Docker image and compose file, and the hosted service at agent-computers.com. Out of scope: findings that need a compromised device or browser profile, and social engineering.

## Security model

What syncs and who can use it:

- **The extension reads only what you authorize.** It holds no host permissions at install; each site you add requests its own Chrome permission. Capturing every site takes an explicit **Allow all sites**, which the Chrome Web Store build doesn't offer. Excluded domains are never captured, and partitioned cookies under an excluded site are dropped.
- **Sync is one way.** Captures go from your browser to your server and on to your agents' browsers. Nothing an agent does changes your browser.
- **Uploads are authenticated per browser.** The extension signs in to its server with OAuth and PKCE. Access tokens last five minutes, and refresh tokens rotate; a rotated token replayed after 30 seconds is treated as stolen, which disconnects that browser and deletes what it uploaded.
- **Another server is a choice you confirm.** Each connection syncs only to its own server. The extension connects to a server other than its build's after a full-page warning, unless the server is on the verified list, which CI checks against each server's `/.well-known/agent-computers.json`, or the browser's administrator approved it by policy. Its OAuth redirect page can be opened from any HTTPS page, so a site can tell the extension is installed; it completes only a flow the extension started.
- **Captures are encrypted at rest.** The web app seals captures with AES-256-GCM under `CAPTURE_ENCRYPTION_KEY`, a key kept outside the database, and stores tokens only as SHA-256 hashes.

What it does not protect against:

- **The operator and the agent's browser are trusted.** Whoever runs the server can use the synced sessions, as can an agent you connected to the web app, and the agent's browser uses them in plaintext. This is not end-to-end encryption yet.
- **Agents act on real accounts.** An agent signed in to a site can do what you can do there. Sync only the sites a task needs.
- **Some sessions don't carry over.** Device-bound sessions (Chrome's Device Bound Session Credentials) stay on your device, and some sites sign out a session used from a new place.
