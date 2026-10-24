import { describe, expect, it } from 'vitest';
import { applyCookies, type CdpCookie, type CdpSend, cookieParamOf, partitionCookies } from './chrome';
import type { CdpCookieParam } from './cookies';

const held = (overrides: Partial<CdpCookie> = {}): CdpCookie => ({
  name: 'sid',
  value: 'v',
  domain: 'example.com',
  path: '/',
  expires: 2e9,
  secure: true,
  httpOnly: true,
  session: false,
  ...overrides,
});
// A cookie jar that answers Storage.getCookies and Storage.setCookies like Chrome: a cookie replaces the one with its
// identity, an expired one deletes it, and a chunk holding a rejected cookie fails whole.
function fakeChrome(cookies: CdpCookie[], reject: (cookie: CdpCookieParam) => boolean = () => false) {
  const jar = new Map(cookies.map(cookie => [`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie]));
  const send: CdpSend = async (method, params) => {
    if (method === 'Storage.getCookies') return { cookies: [...jar.values()] };
    const batch = params.cookies as CdpCookieParam[];
    if (batch.some(reject)) throw new Error('Invalid cookie fields');
    for (const param of batch) {
      const domain = param.domain ?? new URL(param.url!).hostname;
      const key = `${domain}|${param.path}|${param.name}`;
      if (param.expires === 1) jar.delete(key);
      else jar.set(key, { ...held(), ...param, domain, expires: param.expires ?? -1, session: !param.expires });
    }
    return {};
  };
  return { jar, send };
}

describe('applying a sync to Chrome', () => {
  it('clears only the named sites, then sets the incoming cookies', async () => {
    const chrome = fakeChrome([
      held({ name: 'a', domain: '.github.com' }),
      held({ name: 'b', domain: 'api.github.com' }),
      held({ name: 'keep', domain: 'notion.so' }),
    ]);
    const result = await applyCookies(chrome.send, {
      clearSites: ['github.com'],
      cookies: [{ name: 'new', value: 'x', url: 'https://example.com/', path: '/', secure: true, httpOnly: false }],
    });
    expect(result).toEqual({ kept: 1, cleared: 2, set: 1, failed: 0 });
    expect([...chrome.jar.keys()].sort()).toEqual(['example.com|/|new', 'notion.so|/|keep']);
  });
  it('retries a rejected chunk cookie by cookie, so one bad cookie costs only itself', async () => {
    const chrome = fakeChrome([], cookie => cookie.name === 'bad');
    const cookie = (name: string) => ({
      name,
      value: 'x',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: false,
    });
    const result = await applyCookies(chrome.send, {
      clearSites: [],
      cookies: [cookie('one'), cookie('bad'), cookie('two')],
    });
    expect(result).toEqual({ kept: 0, cleared: 0, set: 2, failed: 1 });
  });
  it('turns held cookies back into the params that set them, host-only by URL', () => {
    expect(cookieParamOf(held({ domain: 'host.test', expires: -1, session: true, priority: 'Medium' }))).toEqual({
      name: 'sid',
      value: 'v',
      url: 'https://host.test/',
      path: '/',
      secure: true,
      httpOnly: true,
      priority: 'Medium',
    });
    expect(
      cookieParamOf(held({ domain: '.dom.test', sameSite: 'None', partitionKey: 'https://top.test' })),
    ).toMatchObject({
      domain: '.dom.test',
      sameSite: 'None',
      expires: 2e9,
      partitionKey: { topLevelSite: 'https://top.test', hasCrossSiteAncestor: false },
    });
    expect(partitionCookies([{ domain: '.github.com' }, { domain: 'google.com' }], ['github.com'])).toEqual({
      kept: 1,
      clear: [{ domain: '.github.com' }],
    });
  });
});
