# Boat runtime adapter

Signs the browser in your own [Boat](https://boat.dev) sandbox in to a Clutchbox member's sites, in one call.

```sh
npm i @clutchbox/runtime-boat @clutchbox/sdk @boatdev/sdk
```

```ts
import { applyLatestCapture } from '@clutchbox/runtime-boat';
import { createClient } from '@clutchbox/sdk';
import { BoatApi, Configuration, waitUntilReady } from '@boatdev/sdk';

const client = createClient({ server: 'https://www.clutchbox.dev', apiKey: process.env.CLUTCHBOX_API_KEY! });
const boat = new BoatApi(new Configuration({ basePath: 'https://boat.dev/api/v1', accessToken: process.env.BOAT_API_KEY! }));
const sandboxId = (await boat.create({ noEnv: true })).sandbox.id;
await waitUntilReady(boat, sandboxId);
const { applied } = await applyLatestCapture({ client, member: 'mbr_…', sandbox: { boat, sandboxId } });
```

Boat's commands take no standard input, and Boat keeps every command line in its history, so the capture never goes in one: the adapter mounts a memory-only directory at `/tmp/clutchbox` (with the sandbox's passwordless sudo), writes the capture there with Boat's file API, and the helper deletes it once read. It never reaches the sandbox's disk. Pass `privateDir` to use another directory already in memory. Resuming a stopped Boat sandbox reboots it, so call `applyLatestCapture` again after every resume: Chrome starts again and gets the whole capture, session cookies included. `noEnv: true` keeps your own secrets out of a sandbox you hand to an agent.

Not yet run against Boat itself: the test against the live provider runs only with `BOAT_API_KEY`, and is skipped until then.

A small helper run by the sandbox's Node applies the capture to Chrome over CDP on the sandbox's loopback: the first time every synced site is replaced, then only what changed in the member's browser. Keep `applied`, which holds session cookies, private, and pass it as `previous` on the next call for the same sandbox and profile. When Chrome isn't running, the adapter starts one of its own on the sandbox's desktop, with its own profile (Chrome refuses CDP on its default one) and CDP on port 9222, then applies the whole capture. Point your agent at that Chrome: `http://127.0.0.1:9222` inside the sandbox.

Failures throw `SandboxApplyError` with a `code` (`no_chrome`, `node_too_old`, `cdp_unavailable`, `timeout`, and others), never the command's output, which could hold cookie values. The helper needs Node 22 or later in the sandbox. Sessions bound to a device (Chrome's Device Bound Session Credentials) don't carry over, and some sites sign out a copied session within a day: apply again before each task.
