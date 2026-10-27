// Opens a computer session for a member, already signed in to their synced sites, and drives its Chrome with
// Playwright over the session's CDP URL. Needs an organization API key with the computers scope.
//
//   CLUTCHBOX_SERVER=http://localhost:3000 \
//   CLUTCHBOX_API_KEY=ack_… \
//   node --import tsx examples/playwright.ts [member ID] [URL to open]
//
// Without a member ID it lists the organization's members and when each last synced.
import { chromium } from 'playwright-core';
import { createClient } from '../src/index';

const server = process.env.CLUTCHBOX_SERVER ?? 'https://www.clutchbox.dev';
const apiKey = process.env.CLUTCHBOX_API_KEY;
if (!apiKey) throw new Error('Set CLUTCHBOX_API_KEY to an organization API key (Developers page, API keys).');
const [member, url = 'https://github.com'] = process.argv.slice(2);
const clutchbox = createClient({ server, apiKey });

if (!member) {
  for (const { id, name, lastSyncedAt } of await clutchbox.members.list())
    console.log(`${id}  ${name}  ${lastSyncedAt ? `synced ${lastSyncedAt}` : 'not synced yet'}`);
} else {
  const session = await clutchbox.computers.open({ member, label: 'SDK example' });
  console.log(`Session ${session.id} on computer ${session.computer.id}; sign-ins ${session.sync.status}.`);
  console.log(`Watch it, or take control, at ${session.liveViewUrl}`);
  try {
    const connection = await session.keepConnected({
      connect: cdpUrl => chromium.connectOverCDP(cdpUrl),
      disconnected: browser => new Promise(resolve => browser.once('disconnected', resolve)),
      onConnect: () => console.log('Connected over CDP.'),
    });
    // The computer's own Chrome, with the member's sign-ins in its default context.
    const page = await connection.current.contexts()[0]!.newPage();
    await page.goto(url);
    console.log(`${page.url()}: ${await page.title()}`);
    const listing = await session.exec('ls -1 ~/Downloads | head -n 5');
    console.log(`Downloads: ${listing.stdout.trim() || '(none)'}`);
    connection.stop();
    await page.close();
    // Disconnects, leaving the computer's Chrome running for the next session.
    await connection.current.close();
  } finally {
    await session.close();
  }
}
