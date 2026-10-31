# TypeScript SDK

The developer REST API of a Clutchbox server, typed: read a member's latest synced sign-ins, or open a computer session for a member on a copy of their computer, already signed in, and drive its Chrome from Playwright, browser-use, Stagehand, or any CDP client.

It calls the server with an organization API key (`ack_…`), which an owner or admin creates on the Developers page. A key reads members' captures with the `captures` scope and opens computer sessions with the `computers` scope; new keys have both, and keys made before the `computers` scope have captures alone.

```ts
import { createClient } from '@clutchbox/sdk';
import { chromium } from 'playwright-core';

const clutchbox = createClient({ server: 'https://agents.example.com', apiKey: process.env.CLUTCHBOX_API_KEY! });
const [member] = await clutchbox.members.list(); // { id, name, email, role, lastSyncedAt }

const session = await clutchbox.computers.open({ member: member.id, label: 'Invoices' });
console.log(session.liveViewUrl); // for the member: watch, or take control to help past a sign-in
const browser = await chromium.connectOverCDP(session.cdpUrl);
const page = await browser.contexts()[0].newPage();
await page.goto('https://github.com'); // signed in
const { stdout } = await session.exec('ls ~/Downloads');
await session.close();
```

[`examples/playwright.ts`](examples/playwright.ts) runs this end to end against your own deployment.

## Connect your users

To link your own users to members, register your app under **Connect apps** on the Developers page and send people to `/api/auth/oauth2/authorize` with `scope=openid connect`, PKCE (S256), a `state`, and optionally your `external_user_id` for them. They sign in or sign up, join your organization, connect the extension, and approve. Exchange the code at `/api/auth/oauth2/token` with your client ID and secret (HTTP Basic): the response carries `member`, the ID to pass to `computers.open` and `captures.latest`, and your `external_user_id`. `GET /api/v1/connections` with an API key lists every link. Removing the member or deleting the app ends it.

## Computer sessions

`computers.open({ member })` starts a session on a new fork of the member's computer, a copy with their newest sign-ins applied (`session.sync` says how they applied). Pass `computer: session.computer.id` to reopen that fork later as it was left, and `session` with your current session's ID to replace it on the same fork. A fork unused for a week is deleted.

Each browser the member syncs is its own Chrome profile on their computers, with that browser's sign-ins, so a site can be signed in as a different person in each, such as a work and a personal account. A session uses one: `session.profile`, among `session.profiles` (`{ id, browser, platform, lastSyncedAt, default }`). Pass `profile: id` to `computers.open` to choose one; without it, a reopened fork keeps the profile it had, and a new fork gets the default, the browser that synced last. `captures.latest(member, { profile })` reads one profile's capture, and the default's without it.

- `session.cdpUrl` is a WebSocket URL for the fork's Chrome, through the server, which keeps computers private. It works only while the session is open, and only for this session: keep it as secret as the key. Pass it to `chromium.connectOverCDP`, browser-use's `Browser(cdp_url=…)`, or Stagehand's `localBrowserLaunchOptions.cdpUrl`; the member's sign-ins are in Chrome's default context.
- `session.liveViewUrl` opens live view of the fork for the member, signed in to the server in the same organization. While they take control, the session waits.
- `session.exec(command)` runs a shell command as the desktop user, for up to 90 seconds.
- `session.close()` ends the session and pauses the fork. An idle session's fork pauses after a minute, and the session ends after ten.

A CDP connection keeps the session in use and the fork running while it lasts. The server closes it shortly before its host's limit on one connection (five minutes on Vercel) with code 4000, and while the member has control in live view with code 4002; closed sessions get 4001. Chrome's tabs and sign-ins stay, so connect again with the same URL. `session.keepConnected` does it for you: it reconnects whenever the connection drops while the session is open, after the member hands back, and stops once the session ends.

```ts
const connection = await session.keepConnected({
  connect: url => chromium.connectOverCDP(url),
  disconnected: browser => new Promise(resolve => browser.once('disconnected', resolve)),
  onConnect: browser => console.log('connected', browser.contexts().length),
});
const page = await connection.current.contexts()[0].newPage();
// …
connection.stop(); // before closing it yourself
await session.close();
```

## Errors

Every call throws `ClutchboxError` on a refusal, with the server's `code` and `status`: `unauthenticated` (a wrong or deleted key), `insufficient_scope`, `not_found` (no such member in the key's organization, or profile of theirs), `no_capture`, `profile_not_found` (that browser no longer syncs to the member), `session_not_found`, `session_ended`, `busy` (another session holds the fork; `busyUntil` says until when), `user_in_control`, `credit_exhausted`, `provider_account_refused` (the organization's own provider account refused its key; an owner or admin can update it), and `computer_unavailable`.

## The REST API

All under `/api/v1`, with `Authorization: Bearer <key>`:

| Call | |
| --- | --- |
| `GET /members` | The organization's members. |
| `GET /members/<id>/capture?profile=` | A member's latest capture, the default profile's or `profile`'s (`captures`). |
| `POST /computers/sessions` | `{ member, computer?, session?, label?, profile?, screen? }`: opens a session (`computers`), switching the computer's screen to `screen` (`1440x900`, `1280x1024`, or `1920x1200`) when given. Answers `{ session, computer, cdpUrl, liveViewUrl, profile, profiles, sync, idlePauseSeconds }`, plus `screenUnchanged` when the computer predates screen sizes and keeps its own. |
| `GET /computers/sessions/<id>` | `{ state }`: `open`, `user_in_control`, or `ended`. |
| `POST /computers/sessions/<id>/exec` | `{ command, cwd?, timeoutSeconds? }`: `{ exitCode, stdout, stderr, truncated, timedOut }`. |
| `DELETE /computers/sessions/<id>` | Closes the session. |

A session belongs to the key that opened it: another key, even in the same organization, can't use it.
