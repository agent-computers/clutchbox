import type { CapturedCookie } from '@clutchbox/capture';
import { describe, expect, it } from 'vitest';
import { cookieChanges, toCdpCookie } from './cookies';

// Synthetic cookies only; no real browser data.
const cookie = (overrides: Partial<CapturedCookie> = {}): CapturedCookie => ({
  name: 'sid',
  value: 'local',
  domain: 'example.com',
  hostOnly: true,
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  session: false,
  expirationDate: 2_000_000_000,
  storeId: '0',
  ...overrides,
});

describe('cookie conversion', () => {
  it('maps chrome.cookies fields to CDP CookieParam', () => {
    expect(toCdpCookie(cookie())).toEqual({
      name: 'sid',
      value: 'local',
      url: 'https://example.com/',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      expires: 2_000_000_000,
    });
    expect(
      toCdpCookie(
        cookie({
          domain: '.github.com',
          hostOnly: false,
          path: '/x',
          secure: false,
          httpOnly: false,
          sameSite: 'strict',
        }),
      ),
    ).toEqual({
      name: 'sid',
      value: 'local',
      domain: '.github.com',
      path: '/x',
      secure: false,
      httpOnly: false,
      sameSite: 'Strict',
      expires: 2_000_000_000,
    });
    const session = toCdpCookie(
      cookie({
        domain: 'app.test',
        secure: false,
        path: '/a',
        sameSite: 'unspecified',
        session: true,
        expirationDate: undefined,
      }),
    );
    expect(session).toEqual({
      name: 'sid',
      value: 'local',
      url: 'http://app.test/a',
      path: '/a',
      secure: false,
      httpOnly: true,
    });
    expect(
      toCdpCookie(
        cookie({
          domain: 'embed.test',
          sameSite: 'no_restriction',
          partitionKey: { topLevelSite: 'https://top.test', hasCrossSiteAncestor: true },
        }),
      ),
    ).toMatchObject({
      sameSite: 'None',
      partitionKey: { topLevelSite: 'https://top.test', hasCrossSiteAncestor: true },
    });
  });
});

describe('changed-cookie apply', () => {
  const names = (cookies: { domain: string; name: string }[]) => cookies.map(c => `${c.domain}:${c.name}`).sort();
  const asOf = '2026-10-20T12:00:00.000Z';
  it('sets added and changed cookies, deletes removed ones, and clears sites the capture no longer holds', () => {
    const partitioned = { topLevelSite: 'https://top.test', hasCrossSiteAncestor: false };
    const baseline = [
      cookie({ name: 'same' }),
      cookie({ name: 'rotated' }),
      cookie({ name: 'rolled', expirationDate: 2_000_000_000 }),
      cookie({ name: 'flag' }),
      cookie({ name: 'gone' }),
      cookie({ name: 'part', partitionKey: partitioned }),
      cookie({ name: 'gh', domain: '.github.com', hostOnly: false }),
    ];
    const next = [
      cookie({ name: 'same' }),
      cookie({ name: 'rotated', value: 'new' }),
      // A same-day expiry roll is not a change; an attribute change is.
      cookie({ name: 'rolled', expirationDate: 2_000_000_100 }),
      cookie({ name: 'flag', httpOnly: false }),
      cookie({ name: 'added', domain: 'Example.com' }),
      cookie({ name: 'part', partitionKey: { ...partitioned, hasCrossSiteAncestor: true } }),
      cookie({ name: 'new', domain: 'notion.so' }),
    ];
    const changes = cookieChanges(baseline, next, ['example.com', 'github.com', 'stale.test'], asOf);
    expect(names(changes.set)).toEqual([
      'Example.com:added',
      'example.com:flag',
      'example.com:part',
      'example.com:rotated',
      'notion.so:new',
    ]);
    expect(names(changes.remove)).toEqual(['example.com:gone', 'example.com:part']);
    expect(changes.clearSites).toEqual(['github.com', 'stale.test']);
    expect(changes.addedOrRemovedSites).toEqual(['example.com', 'github.com', 'notion.so', 'stale.test']);
    // Rotations alone are not named.
    expect(cookieChanges(baseline.slice(0, 2), next.slice(0, 2), ['example.com'], asOf).addedOrRemovedSites).toEqual(
      [],
    );
  });
  it('replaces every target site wholesale without a baseline', () => {
    const next = [cookie(), cookie({ name: 'gh', domain: 'github.com' })];
    expect(cookieChanges(null, next, ['old.test', 'github.com'], asOf)).toEqual({
      set: next,
      remove: [],
      clearSites: ['example.com', 'github.com', 'old.test'],
      addedOrRemovedSites: ['example.com', 'github.com', 'old.test'],
    });
  });
  it('treats a host cookie that expired as lapsed, not deleted: no removal, no clear, no notice', () => {
    const expiredAt = Date.parse(asOf) / 1000 - 60;
    const baseline = [
      cookie({ name: 'sid', expirationDate: expiredAt }),
      cookie({ name: 'pref' }),
      cookie({ name: 'gh', domain: 'github.com', expirationDate: expiredAt }),
      cookie({ name: 'gone', domain: 'notion.so' }),
    ];
    expect(
      cookieChanges(baseline, [cookie({ name: 'pref' })], ['example.com', 'github.com', 'notion.so'], asOf),
    ).toEqual({ set: [], remove: [], clearSites: ['notion.so'], addedOrRemovedSites: ['notion.so'] });
  });
});
