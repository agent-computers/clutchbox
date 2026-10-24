# @agent-computers/apply

Applies a capture to any Chrome over the Chrome DevTools Protocol, writing only what changed.

```ts
import { applyCookies, cookieChanges, expiredCdpCookie, toCdpCookie } from '@agent-computers/apply';

// What the new capture changes since the one last applied (null the first time): cookies to set, cookies to
// remove, and sites to clear.
const changes = cookieChanges(previous?.cookies ?? null, capture.cookies, previous?.sites ?? [], capture.completedAt);
// `send` is any CDP client on a browser-level session: Playwright, Puppeteer, chrome-remote-interface, or a WebSocket.
await applyCookies((method, params) => cdp.send(method, params), {
  clearSites: changes.clearSites,
  cookies: [...changes.set.map(toCdpCookie), ...changes.remove.map(expiredCdpCookie)],
});
```

The first apply replaces every synced site's cookies. Later applies set only cookies that changed in your browser, so the agent's browser keeps cookies it refreshed itself, and clear sites you signed out of. Other sites are never touched. For Playwright, use [`@agent-computers/playwright`](../playwright), which does this for you.
