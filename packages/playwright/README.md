# Playwright adapter

Applies a capture to a Chromium browser context, so an agent's browser starts signed in to the sites you sync.

```ts
import { applyCapture } from '@agent-computers/playwright';
import { chromium } from 'playwright';

const browser = await chromium.launch();
const context = await browser.newContext();
let applied = (await applyCapture(context, capture)).applied;
// Later, with a newer capture: only what changed in your browser is written, and the context keeps cookies it
// refreshed itself.
applied = (await applyCapture(context, next, applied)).applied;
```

The first apply replaces every synced site's cookies; later ones, given the previous result, write only what changed and clear sites you signed out of. Other sites and other contexts are not touched. `applied` holds session cookies, so keep it private.

It works on any Chromium Playwright drives: a launched browser, a persistent context, or a running Chrome you attach to with `chromium.connectOverCDP(url)`. That last one is how to use it with agents that drive Chrome by its CDP URL, such as browser-use: start Chrome with remote debugging, apply the capture to its default context, then give the agent the same CDP URL.

A capture is the [capture format](../capture)'s `Capture`. Read a member's latest one from a Clutchbox server with an organization API key, which an owner or admin creates on the Organization page:

```ts
import { applyCapture, fetchCapture, listMembers } from '@agent-computers/playwright';

const server = 'https://www.clutchbox.dev';
const apiKey = process.env.CLUTCHBOX_API_KEY!; // ack_…
const [member] = await listMembers({ server, apiKey }); // { id, name, email, role, lastSyncedAt }
const capture = await fetchCapture({ server, apiKey, member: member.id });
await applyCapture(context, capture);
```

[`examples/latest-capture.ts`](examples/latest-capture.ts) does this end to end with a local browser. Both calls throw `CaptureRequestError`, whose `code` is the server's: `unauthenticated` for a wrong or revoked key, `not_found` for someone not in the key's organization, `no_capture` for a member who hasn't synced yet. They are `GET /api/v1/members` and `GET /api/v1/members/<id>/capture` with `Authorization: Bearer <key>`, if you'd rather call them yourself.

Sessions bound to a device (Chrome's Device Bound Session Credentials) do not carry over, and some sites sign out a copied session within a day; sync again before each task.
