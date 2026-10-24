# Playwright adapter

Applies a capture to a Chromium browser context, so an agent's browser starts signed in to the sites you sync.

```ts
import { applyCapture, fetchCapture } from '@agent-computers/playwright';
import { chromium } from 'playwright';

const browser = await chromium.launch();
const context = await browser.newContext();
const capture = await fetchCapture({ server: 'https://sync.example.com', apiKey: process.env.API_KEY! });
let applied = capture ? (await applyCapture(context, capture)).applied : null;
// Later, with a newer capture: only what changed in your browser is written, and the context keeps cookies it
// refreshed itself.
const next = await fetchCapture({ server: 'https://sync.example.com', apiKey: process.env.API_KEY! });
if (next) applied = (await applyCapture(context, next, applied)).applied;
```

The first apply replaces every synced site's cookies; later ones, given the previous result, write only what changed and clear sites you signed out of. Other sites and other contexts are not touched. `applied` holds session cookies, so keep it private.

It works on any Chromium Playwright drives: a launched browser, a persistent context, or a running Chrome you attach to with `chromium.connectOverCDP(url)`. That last one is how to use it with agents that drive Chrome by its CDP URL, such as browser-use: start Chrome with remote debugging, apply the capture to its default context, then give the agent the same CDP URL.

Sessions bound to a device (Chrome's Device Bound Session Credentials) do not carry over, and some sites sign out a copied session within a day; sync again before each task.
