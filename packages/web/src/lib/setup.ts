import { siteGroups } from '@agent-computers/capture/sites';

// Pure helpers for the setup checklist on the overview.

// A prompt for each suggested site (packages/capture/src/sites.ts), keyed by its name. The overview rotates through
// the ones for the user's synced sites; whole-browser sync has no added sites, so it rotates through all of them.
const prompts: { readonly [name: string]: string } = {
  GitHub: 'list my open GitHub pull requests',
  Notion: 'find the Notion page I edited most recently',
  Slack: 'summarize my unread Slack messages',
  Linear: 'list the Linear issues assigned to me',
  Figma: 'list the Figma files I edited this week',
  Atlassian: 'list the Jira tickets assigned to me',
  X: 'summarize the top posts on my X timeline',
  LinkedIn: 'summarize my unread LinkedIn messages',
  Reddit: 'summarize the top posts on my Reddit home feed',
  Instagram: 'list my unread Instagram messages',
  Facebook: 'list my Facebook notifications',
  Discord: 'summarize my unread Discord messages',
  Amazon: 'list my Amazon cart',
  Airbnb: 'list my upcoming Airbnb trips',
  'Booking.com': 'list my upcoming Booking.com reservations',
  Uber: 'list my recent Uber trips',
  DoorDash: 'list my DoorDash cart',
  Instacart: 'list my Instacart cart',
  OpenTable: 'list my upcoming OpenTable reservations',
};
const withClutchbox = (task: string) => `Use Clutchbox to ${task}.`;
export function promptsFor(sync: { mode: string | null; sites: string[] }) {
  if (sync.mode === 'whole-browser') return Object.values(prompts).map(withClutchbox);
  const found = siteGroups(sync.sites).map(({ name }) =>
    withClutchbox(prompts[name] ?? `open ${name} and tell me what's there`),
  );
  return found.length ? found : [withClutchbox("open my computer and tell me what's on its screen")];
}

// Browser sync runs in desktop Chromium browsers (Chrome, Edge, Brave, Arc, ...) on macOS, Windows, or Linux;
// not ChromeOS.
type UserAgentData = { brands?: { brand: string }[]; mobile?: boolean; platform?: string };
export function isSupportedBrowser(userAgent: string, data?: UserAgentData | null) {
  if (data?.brands?.length)
    return (
      data.brands.some(({ brand }) => brand === 'Chromium') &&
      !data.mobile &&
      ['macOS', 'Windows', 'Linux'].includes(data.platform ?? '')
    );
  // Without client hints, Chromium browsers name themselves after "Chrome/".
  return (
    /\bChrome\/\d/.test(userAgent) &&
    /\b(Macintosh|Windows NT|Linux|X11)\b/.test(userAgent) &&
    !/\b(SamsungBrowser|Android|Mobile|CrOS)\b/.test(userAgent)
  );
}
