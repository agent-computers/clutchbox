# E2B runtime adapter

Signs the browser in your own [E2B](https://e2b.dev) sandbox in to a Clutchbox member's sites, in one call.

```sh
npm i @clutchbox/runtime-e2b @clutchbox/sdk e2b
```

```ts
import { applyLatestCapture, TEMPLATE } from '@clutchbox/runtime-e2b';
import { createClient } from '@clutchbox/sdk';
import { Sandbox } from 'e2b';

const client = createClient({ server: 'https://www.clutchbox.dev', apiKey: process.env.CLUTCHBOX_API_KEY! });
const sandbox = await Sandbox.create(TEMPLATE); // E2B_API_KEY
const { applied } = await applyLatestCapture({ client, member: 'mbr_…', sandbox });
```

`TEMPLATE` is `agent-computers-desktop`, Clutchbox's public E2B template: a desktop with Google Chrome already running with CDP on port 9222, the one Clutchbox's own computers start from. Any E2B team can start sandboxes from it, and E2B bills your team for them. Any other template works too if it has Node 22 and Chrome or Chromium. E2B keeps a paused sandbox's memory, so Chrome and its cookies are still there on resume.

The capture goes to the sandbox on a command's standard input, and a small helper run by the sandbox's Node applies it to Chrome over CDP on the sandbox's loopback: the first time every synced site is replaced, then only what changed in the member's browser. Keep `applied`, which holds session cookies, private, and pass it as `previous` on the next call for the same sandbox and profile. When Chrome isn't running, the adapter starts one of its own on the sandbox's desktop, with its own profile (Chrome refuses CDP on its default one) and CDP on port 9222, then applies the whole capture. Point your agent at that Chrome: `http://127.0.0.1:9222` inside the sandbox.

Failures throw `SandboxApplyError` with a `code` (`no_chrome`, `node_too_old`, `cdp_unavailable`, `timeout`, and others), never the command's output, which could hold cookie values. The helper needs Node 22 or later in the sandbox. Sessions bound to a device (Chrome's Device Bound Session Credentials) don't carry over, and some sites sign out a copied session within a day: apply again before each task.
