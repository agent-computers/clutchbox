import { describe, expect, it } from 'vitest';
import { apiOriginOf, serverOrigin } from './server';

describe('serverOrigin', () => {
  it('keeps only the origin', () => {
    expect(serverOrigin('https://clutchbox.example.com/app?x=1&y=2#z')).toBe('https://clutchbox.example.com');
  });

  it('allows plain HTTP only on this machine', () => {
    expect(serverOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(serverOrigin('http://[::1]:3000')).toBe('http://[::1]:3000');
    expect(() => serverOrigin('http://clutchbox.example.com')).toThrow('https');
  });

  it('refuses what is not an HTTPS URL', () => {
    expect(() => serverOrigin('clutchbox.example.com & calc')).toThrow('must be a URL');
    expect(() => serverOrigin('file:///etc/passwd')).toThrow('https');
    expect(() => serverOrigin('https://user:pass@clutchbox.example.com')).toThrow('username');
  });
});

describe('apiOriginOf', () => {
  const answering = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;
  it("takes the API's origin from the server's well-known document", async () => {
    expect(
      await apiOriginOf('https://clutchbox.example.com', answering({ api: 'https://api.clutchbox.example.com' })),
    ).toBe('https://api.clutchbox.example.com');
  });

  it("falls back to the server's own origin for no answer, an old one, or one it must not trust", async () => {
    const server = 'https://clutchbox.example.com';
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await apiOriginOf(server, failing)).toBe(server);
    expect(await apiOriginOf(server, answering({ origin: server }))).toBe(server);
    expect(await apiOriginOf(server, answering({ api: 'http://api.clutchbox.example.com' }))).toBe(server);
    expect(await apiOriginOf(server, answering({ api: 'clutchbox.example.com & calc' }))).toBe(server);
  });
});
