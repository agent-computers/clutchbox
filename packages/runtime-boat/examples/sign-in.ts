// The README's example: signs a new sandbox's browser in to a member's synced sites.
//
//   CLUTCHBOX_API_KEY=ack_… node --import tsx examples/sign-in.ts <member ID>

import { BoatApi, Configuration, waitUntilReady } from '@boatdev/sdk';
import { createClient } from '@clutchbox/sdk';
import { applyLatestCapture } from '../src/index';

const member = process.argv[2];
if (!member) throw new Error('Pass a member ID, from client.members.list().');

const client = createClient({ server: 'https://www.clutchbox.dev', apiKey: process.env.CLUTCHBOX_API_KEY! });
const boat = new BoatApi(
  new Configuration({ basePath: 'https://boat.dev/api/v1', accessToken: process.env.BOAT_API_KEY! }),
);
const sandboxId = (await boat.create({ noEnv: true })).sandbox.id;
await waitUntilReady(boat, sandboxId);
const { applied } = await applyLatestCapture({ client, member, sandbox: { boat, sandboxId } });
console.log(`Applied ${applied.cookies.length} cookies for ${applied.sites.join(', ')}.`);
