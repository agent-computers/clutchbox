// The README's example: signs a new sandbox's browser in to a member's synced sites.
//
//   CLUTCHBOX_API_KEY=ack_… node --import tsx examples/sign-in.ts <member ID>

import { createClient } from '@clutchbox/sdk';
import { Sandbox } from 'e2b';
import { applyLatestCapture, TEMPLATE } from '../src/index';

const member = process.argv[2];
if (!member) throw new Error('Pass a member ID, from client.members.list().');

const client = createClient({ server: 'https://www.clutchbox.dev', apiKey: process.env.CLUTCHBOX_API_KEY! });
const sandbox = await Sandbox.create(TEMPLATE); // E2B_API_KEY
const { applied } = await applyLatestCapture({ client, member, sandbox });
console.log(`Applied ${applied.cookies.length} cookies for ${applied.sites.join(', ')}.`);
