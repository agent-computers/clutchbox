import { describe, expect, it } from 'vitest';
import { siteGroups, siteName } from './sites';

describe('siteGroups', () => {
  it('groups suggested sites under one name and keeps other domains as their own group', () => {
    expect(siteGroups(['github.com', 'x.com', 'example.com', 'twitter.com', 'x.com'])).toEqual([
      { name: 'GitHub', sites: ['github.com'] },
      { name: 'X', sites: ['x.com', 'twitter.com'] },
      { name: 'example.com', sites: ['example.com'] },
    ]);
    expect(siteGroups([])).toEqual([]);
    expect(siteName('notion.com')).toBe('Notion');
    expect(siteName('example.com')).toBe('example.com');
  });
});
