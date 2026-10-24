import { describe, expect, it } from 'vitest';
import {
  type CapturedCookie,
  captureSchema,
  compareVersions,
  cookieExcluded,
  cookieSchema,
  exclusionsSchema,
  parseSettings,
  requestSchema,
  siteOfInput,
  sitesSchema,
  withCompanions,
} from './index';

const cookie: CapturedCookie = {
  name: 'synthetic',
  value: 'fixture-only',
  domain: 'capture.test',
  hostOnly: true,
  path: '/private',
  secure: true,
  httpOnly: true,
  sameSite: 'strict',
  session: false,
  expirationDate: 2000000000,
  storeId: '0',
  partitionKey: { topLevelSite: 'https://other.test', hasCrossSiteAncestor: true },
};
const bundle = () => ({
  schemaVersion: 2,
  id: crypto.randomUUID(),
  scope: { mode: 'whole-browser', excludedDomains: [] },
  startedAt: '2026-10-13T00:00:00.000Z',
  completedAt: '2026-10-13T00:00:01.000Z',
  consistency: 'non-atomic-cookie-read',
  coverage: 'cookies-only',
  storeId: '0',
  cookies: [cookie],
});
describe('whole-browser capture contract', () => {
  it('preserves cookie security, lifetime and partition metadata', () => {
    expect(cookieSchema.parse(cookie)).toEqual(cookie);
    expect(cookieSchema.safeParse({ ...cookie, partitionKey: {} }).success).toBe(false);
    expect(cookieSchema.safeParse({ ...cookie, session: true }).success).toBe(false);
    expect(cookieSchema.safeParse({ ...cookie, extra: 'future attribute' }).success).toBe(false);
  });
  it('canonicalizes exclusion domains and rejects URLs or wildcard patterns', () => {
    expect(exclusionsSchema.parse([' Example.COM ', 'example.com.', 'bücher.test'])).toEqual([
      'example.com',
      'xn--bcher-kva.test',
    ]);
    for (const input of [
      'https://example.com',
      '*.test',
      'example.com:443',
      'example.com/path',
      'x@host.test',
      'bad..test',
      '%65xample.com',
    ]) {
      expect(exclusionsSchema.safeParse([input]).success, input).toBe(false);
    }
  });
  it('excludes subdomains and shared parent-domain cookies without suffix spoofing', () => {
    expect(cookieExcluded(cookie, ['capture.test'])).toBe(true);
    expect(cookieExcluded({ ...cookie, domain: 'sub.capture.test' }, ['capture.test'])).toBe(true);
    expect(cookieExcluded({ ...cookie, domain: '.capture.test', hostOnly: false }, ['sub.capture.test'])).toBe(true);
    expect(cookieExcluded(cookie, ['sub.capture.test'])).toBe(false);
    expect(cookieExcluded({ ...cookie, domain: 'evilcapture.test' }, ['capture.test'])).toBe(false);
    expect(cookieExcluded({ ...cookie, domain: 'capture.test.evil.test' }, ['capture.test'])).toBe(false);
  });
  it('excludes partition context belonging to excluded sites', () => {
    expect(cookieExcluded(cookie, ['other.test'])).toBe(true);
    expect(cookieExcluded(cookie, ['sub.other.test'])).toBe(true);
    expect(cookieExcluded(cookie, ['unrelated.test'])).toBe(false);
  });
  it('accepts arbitrary cookie domains but rejects excluded cookies and mixed stores', () => {
    expect(captureSchema.safeParse(bundle()).success).toBe(true);
    expect(captureSchema.safeParse({ ...bundle(), cookies: [{ ...cookie, domain: 'arbitrary.test' }] }).success).toBe(
      true,
    );
    expect(
      captureSchema.safeParse({ ...bundle(), scope: { mode: 'whole-browser', excludedDomains: ['capture.test'] } })
        .success,
    ).toBe(false);
    expect(captureSchema.safeParse({ ...bundle(), storeId: '1' }).success).toBe(false);
    expect(captureSchema.safeParse({ ...bundle(), completedAt: '2026-10-12T00:00:00.000Z' }).success).toBe(false);
    expect(captureSchema.safeParse({ ...bundle(), schemaVersion: 1 }).success).toBe(false);
  });
  it('rejects caller-supplied destinations and legacy per-site commands', () => {
    expect(requestSchema.safeParse({ type: 'capture', destination: 'https://evil.test' }).success).toBe(false);
    expect(requestSchema.safeParse({ type: 'capture', siteId: 'fixture-a' }).success).toBe(false);
  });
});
describe('added sites', () => {
  it('normalizes added sites to registrable domains, from a domain or a pasted address', () => {
    expect(sitesSchema.parse(['mail.google.com', 'Google.com', 'news.bbc.co.uk'])).toEqual(['bbc.co.uk', 'google.com']);
    expect(siteOfInput(' https://mail.google.com/mail/u/0 ')).toBe('google.com');
    expect(siteOfInput('github.com')).toBe('github.com');
    for (const input of [
      '',
      'not a site',
      'ftp://example.com',
      '*.example.com',
      'example.com/path',
      'http://127.0.0.1:8080/',
    ])
      expect(siteOfInput(input), input).toBeUndefined();
    expect(withCompanions('x.com')).toEqual(['x.com', 'twitter.com']);
  });
  it('rejects cookies outside the added sites', () => {
    const scope = { mode: 'sites', sites: ['capture.test'], excludedDomains: [] };
    expect(captureSchema.safeParse({ ...bundle(), scope }).success).toBe(true);
    expect(
      captureSchema.safeParse({
        ...bundle(),
        scope,
        cookies: [{ ...cookie, domain: '.sub.capture.test', hostOnly: false }],
      }).success,
    ).toBe(true);
    expect(captureSchema.safeParse({ ...bundle(), scope: { ...scope, sites: ['other.test'] } }).success).toBe(false);
  });
  it('reads whole-browser settings from before site selection as all sites', () => {
    const legacy = { consentVersion: 1, connected: true, paused: false, excludedDomains: ['bank.test'] };
    expect(parseSettings(legacy)).toEqual({ ...legacy, consentVersion: 2, mode: 'all', sites: [] });
    expect(parseSettings({ ...legacy, extra: true })).toMatchObject({ connected: false, mode: 'sites' });
  });
});
it('compares extension versions numerically', () => {
  expect(compareVersions('0.10.0', '0.9.1')).toBe(1);
  expect(compareVersions('0.5', '0.5.0')).toBe(0);
  expect(compareVersions('0', '0.0.1')).toBe(-1);
  expect(compareVersions('nonsense', '0.0.0')).toBe(0);
});
