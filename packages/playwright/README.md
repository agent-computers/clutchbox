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

A capture is the [capture format](../capture)'s `Capture`. Reading a member's latest one from the web app, over REST with an organization API key, is [planned](https://github.com/agent-computers/agent-computers/issues/7); until then, agents get synced sign-ins on the web app's computers.

Sessions bound to a device (Chrome's Device Bound Session Credentials) do not carry over, and some sites sign out a copied session within a day; sync again before each task.
