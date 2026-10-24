import { describe, expect, it } from 'vitest';
import { captureDigest, siteOfCookie, siteOfHost, siteOfUrl } from './sync';

const cookie = {
  name: 'sid',
  value: 'fixture-value',
  domain: '.example.com',
  hostOnly: false,
  path: '/',
  expirationDate: 1_900_000_000,
};
describe('sync helpers', () => {
  it.each([
    ['example.com', 'example.com'],
    ['.example.com', 'example.com'],
    ['WWW.Example.COM.', 'example.com'],
    ['a.b.example.com', 'example.com'],
    ['bbc.co.uk', 'bbc.co.uk'],
    ['news.bbc.co.uk', 'bbc.co.uk'],
    ['shop.example.com.au', 'example.com.au'],
    ['localhost', 'localhost'],
    ['github.io', 'github.io'],
  ])('siteOfHost(%s) is %s', (host, site) => {
    expect(siteOfHost(host)).toBe(site);
  });
  it('derives sites from URLs and cookies', () => {
    expect(siteOfUrl('https://mail.google.com:443/x')).toBe('google.com');
    expect(siteOfCookie(cookie)).toBe('example.com');
  });
  it('digests are order-independent, ignore same-day expiry rolls, and change with values', async () => {
    const other = { ...cookie, name: 'pref', value: 'dark' };
    const base = await captureDigest([cookie, other]);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await captureDigest([other, cookie])).toBe(base);
    const day = Math.floor(cookie.expirationDate / 86_400) * 86_400;
    expect(await captureDigest([{ ...cookie, expirationDate: day + 10 }, other])).toBe(
      await captureDigest([{ ...cookie, expirationDate: day + 20 }, other]),
    );
    expect(await captureDigest([{ ...cookie, expirationDate: day + 86_400 }, other])).not.toBe(
      await captureDigest([{ ...cookie, expirationDate: day }, other]),
    );
    expect(await captureDigest([{ ...cookie, value: 'rotated' }, other])).not.toBe(base);
    expect(
      await captureDigest([
        { ...cookie, partitionKey: { topLevelSite: 'https://example.org', hasCrossSiteAncestor: true } },
        other,
      ]),
    ).not.toBe(base);
  });
  it('scoped digests change with the mode and sites, but not with site order or exclusions', async () => {
    const cookieOnly = await captureDigest([cookie]);
    const sites = await captureDigest([cookie], { mode: 'sites', sites: ['example.com', 'github.com'] });
    expect(await captureDigest([cookie], undefined)).toBe(cookieOnly);
    expect(sites).not.toBe(cookieOnly);
    expect(await captureDigest([cookie], { mode: 'sites', sites: ['github.com', 'example.com'] })).toBe(sites);
    const scope = { mode: 'sites' as const, sites: ['example.com', 'github.com'], excludedDomains: ['example.org'] };
    expect(await captureDigest([cookie], scope)).toBe(sites);
    expect(await captureDigest([cookie], { mode: 'sites', sites: ['example.com'] })).not.toBe(sites);
    expect(await captureDigest([], { mode: 'sites', sites: [] })).not.toBe(
      await captureDigest([], { mode: 'sites', sites: ['github.com'] }),
    );
    expect(await captureDigest([cookie], { mode: 'whole-browser' })).not.toBe(
      await captureDigest([cookie], { mode: 'sites', sites: [] }),
    );
  });
});
