# @agent-computers/e2b

Agent computers on [E2B](https://e2b.dev): a Linux desktop sandbox with Chrome that pauses when idle, resumes with its memory, and stays signed in to the sites you sync. It implements the [`ComputerProvider`](../computer) interface: screenshots, mouse and keyboard, commands, Chrome DevTools Protocol, file downloads, live view, and cookie sync.

## Build the template

Computers start from an E2B template with current Chrome, Node, and this package's helpers ([`src/template.ts`](src/template.ts)). Build it once into your E2B team:

```sh
E2B_API_KEY=... E2B_COMPUTER_TEMPLATE=agent-computers-desktop bun run --cwd packages/e2b build-template
```

## Use it

```ts
import { e2bComputerProvider } from '@agent-computers/e2b';
import { toCdpCookie } from '@agent-computers/apply';

const provider = e2bComputerProvider(); // E2B_COMPUTER_TEMPLATE, or agent-computers-desktop
const sandboxId = await provider.create('my-computer', 10 * 60_000);
const computer = await provider.connect(sandboxId, 10 * 60_000);

// Sign the computer's Chrome in to the synced sites.
await computer.syncCookies({ clearSites: capture.scope.sites, cookies: capture.cookies.map(toCdpCookie), budgetMs: 60_000 });

await computer.act({ type: 'click', x: 640, y: 400 });
const png = await computer.screenshot();
await provider.pause(sandboxId); // resumes later with connect
```

Computers are created private: every port needs E2B's traffic token, which stays on your server. Helpers are versioned (`REVISION`), and `refresh` brings a computer made from an older template up to date without rebuilding it.
