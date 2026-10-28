# Instabox runtime adapter

Signs the browser in your own [Instabox](https://instabox.sh) sandbox in to a Clutchbox member's sites, in one call.

```sh
npm i @clutchbox/runtime-instabox @clutchbox/sdk @insforge/instabox-sdk
```

```ts
import { applyLatestCapture } from '@clutchbox/runtime-instabox';
import { createClient } from '@clutchbox/sdk';
import { Sandbox } from '@insforge/instabox-sdk';

const client = createClient({ server: 'https://www.clutchbox.dev', apiKey: process.env.CLUTCHBOX_API_KEY! });
const sandbox = await Sandbox.create(); // INSTABOX_API_KEY; the agent-browser template
const { applied } = await applyLatestCapture({ client, member: 'mbr_…', sandbox });
```

Instabox's default `agent-browser` template has Chromium on an Xfce desktop and documents no CDP access from outside, and a published port would be open to anyone, so the adapter works through Instabox's command API and starts a Chromium of its own on that desktop. Instabox takes at most 1 MiB of standard input per command, so a larger capture goes in several. Instabox keeps a paused sandbox's memory; if a resume can't restore it, Chromium is gone and the next apply starts it and applies everything again.

Not yet run against Instabox itself: the test against the live provider runs only with `INSTABOX_API_KEY`, and is skipped until then.

The capture goes to the sandbox on a command's standard input (in pieces of at most 1 MiB), and a small helper run by the sandbox's Node applies it to Chrome over CDP on the sandbox's loopback: the first time every synced site is replaced, then only what changed in the member's browser. Keep `applied`, which holds session cookies, private, and pass it as `previous` on the next call for the same sandbox and profile. When Chrome isn't running, the adapter starts one of its own on the sandbox's desktop, with its own profile (Chrome refuses CDP on its default one) and CDP on port 9222, then applies the whole capture. Point your agent at that Chrome: `http://127.0.0.1:9222` inside the sandbox.

Failures throw `SandboxApplyError` with a `code` (`no_chrome`, `node_too_old`, `cdp_unavailable`, `timeout`, and others), never the command's output, which could hold cookie values. The helper needs Node 22 or later in the sandbox. Sessions bound to a device (Chrome's Device Bound Session Credentials) don't carry over, and some sites sign out a copied session within a day: apply again before each task.
