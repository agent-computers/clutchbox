# @agent-computers/e2b

Computers for agents on [E2B](https://e2b.dev): a Linux desktop sandbox with Chrome that pauses when idle, resumes with its memory, and stays signed in to the sites you sync. It implements the [`ComputerProvider`](../computer) interface: screenshots, mouse and keyboard, commands, Chrome DevTools Protocol (one command at a time, or a connection the server relays), file downloads, live view, and cookie sync.

## The template

Computers start from an E2B template with current Chrome, Node, and this package's helpers ([`src/template.ts`](src/template.ts)). Clutchbox builds it from this repository's main branch, rebuilds it weekly for current Chrome, and publishes it on E2B as `agent-computers-desktop`, so any E2B team can start computers from it with no build of its own. Refresh brings its helpers to your checkout's version on open.

To run your own instead, build it into your E2B team. E2B finds a template by name in your own team first, so computers then start from yours:

```sh
E2B_API_KEY=... bun run --cwd packages/e2b build-template
```

Set `E2B_COMPUTER_TEMPLATE` to build and use another name.

E2B fixes a computer's CPUs and memory when its template is built, so there is one template per size (`COMPUTER_SIZES` in `@agent-computers/computer`): the 1x computer (2 vCPUs, 4 GB) uses the bare name, and the 2x (4 vCPUs, 8 GB) and 4x (8 vCPUs, 16 GB) add `-2x` and `-4x`. The build makes all three, and a fork runs at the size of the computer it was snapshotted from.

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
