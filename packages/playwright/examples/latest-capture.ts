// Signs a local Playwright browser in to a member's synced sites with an organization API key.
//
//   CLUTCHBOX_SERVER=https://www.clutchbox.dev \
//   CLUTCHBOX_API_KEY=ack_… \
//   node --import tsx examples/latest-capture.ts [member ID] [URL to open]
//
// Without a member ID it lists the organization's members and when each last synced.
import { chromium } from 'playwright-core';
import { applyCapture, fetchCapture, listMembers } from '../src/index';

const server = process.env.CLUTCHBOX_SERVER ?? 'https://www.clutchbox.dev';
const apiKey = process.env.CLUTCHBOX_API_KEY;
if (!apiKey) throw new Error('Set CLUTCHBOX_API_KEY to an organization API key (Organization page, API keys).');
const [member, url = 'https://github.com'] = process.argv.slice(2);

if (!member) {
  for (const { id, name, lastSyncedAt } of await listMembers({ server, apiKey }))
    console.log(`${id}  ${name}  ${lastSyncedAt ? `synced ${lastSyncedAt}` : 'not synced yet'}`);
} else {
  const capture = await fetchCapture({ server, apiKey, member });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const { applied } = await applyCapture(context, capture);
  console.log(`Applied ${applied.cookies.length} cookies for ${applied.sites.join(', ')}.`);
  const page = await context.newPage();
  await page.goto(url);
  console.log('Close the browser window to finish.');
  await new Promise(resolve => browser.on('disconnected', resolve));
}
