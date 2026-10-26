// Sites offered in the setup tab and popup. `sites` is what one Add requests, before companions are added.
// The server sends its own list (config.ts); this one is the extension's fallback and the web app's.
export interface SuggestedSite {
  name: string;
  detail?: string | undefined;
  category: string;
  sites: string[];
  // A path on the Clutchbox site, such as /site-icons/github.png.
  icon?: string | undefined;
}
export const suggestedSites: readonly SuggestedSite[] = [
  { category: 'Work', name: 'GitHub', sites: ['github.com'] },
  { category: 'Work', name: 'Notion', sites: ['notion.so', 'notion.com'] },
  { category: 'Work', name: 'Slack', sites: ['slack.com'] },
  { category: 'Work', name: 'Linear', sites: ['linear.app'] },
  { category: 'Work', name: 'Figma', sites: ['figma.com'] },
  { category: 'Work', name: 'Atlassian', sites: ['atlassian.com', 'atlassian.net'] },
  { category: 'Social', name: 'X', sites: ['x.com', 'twitter.com'] },
  { category: 'Social', name: 'LinkedIn', sites: ['linkedin.com'] },
  { category: 'Social', name: 'Reddit', sites: ['reddit.com'] },
  { category: 'Social', name: 'Instagram', sites: ['instagram.com'] },
  { category: 'Social', name: 'Facebook', sites: ['facebook.com'] },
  { category: 'Social', name: 'Discord', sites: ['discord.com'] },
  { category: 'Everyday', name: 'Amazon', sites: ['amazon.com'] },
  { category: 'Everyday', name: 'Airbnb', sites: ['airbnb.com'] },
  { category: 'Everyday', name: 'Booking.com', sites: ['booking.com'] },
  { category: 'Everyday', name: 'Uber', sites: ['uber.com'] },
  { category: 'Everyday', name: 'DoorDash', sites: ['doordash.com'] },
  { category: 'Everyday', name: 'Instacart', sites: ['instacart.com'] },
  { category: 'Everyday', name: 'OpenTable', sites: ['opentable.com'] },
];
// Sites that share sign-in with another domain are added together, or sign-in breaks.
export const companions: { readonly [site: string]: readonly string[] } = {
  'x.com': ['twitter.com'],
  'twitter.com': ['x.com'],
  'youtube.com': ['google.com'],
  'atlassian.com': ['atlassian.net'],
  'atlassian.net': ['atlassian.com'],
  'notion.so': ['notion.com'],
  'notion.com': ['notion.so'],
};
export const withCompanions = (site: string, related: { readonly [site: string]: readonly string[] } = companions) => [
  site,
  ...(related[site] ?? []),
];
const suggestionOf = (site: string, suggestions: readonly SuggestedSite[]) =>
  suggestions.find(suggestion => suggestion.sites.includes(site));
// The suggestion's name, otherwise the domain itself.
export const siteName = (site: string, suggestions: readonly SuggestedSite[] = suggestedSites) =>
  suggestionOf(site, suggestions)?.name ?? site;
// Groups added sites under their suggestion's name, in the order each group first appears.
export function siteGroups(
  sites: string[],
  suggestions: readonly SuggestedSite[] = suggestedSites,
): { name: string; sites: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const site of sites) {
    const name = siteName(site, suggestions);
    const group = groups.get(name);
    if (!group) groups.set(name, [site]);
    else if (!group.includes(site)) group.push(site);
  }
  return Array.from(groups, ([name, sites]) => ({ name, sites }));
}
