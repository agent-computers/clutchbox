import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProductProxy } from './proxy';

// Routing that decides where every visitor lands: the canonical origin first, then / by session cookie.
const canonical = 'https://www.example.test';
const landing = createProductProxy({ signedOut: { rewrite: '/home' } });
const signIn = createProductProxy({ signedOut: { redirect: '/sign-in' } });
const request = (url: string, { cookie, method = 'GET' }: { cookie?: string | undefined; method?: string } = {}) =>
  new NextRequest(url, { method, headers: cookie ? { cookie } : {} });
const visit = (url: string, options?: { cookie?: string | undefined; method?: string }) =>
  landing(request(url, options));
const session = 'better-auth.session_token=synthetic';
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('proxy', () => {
  it('sends production aliases to the canonical origin before routing on the session, keeping signed queries', () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('BETTER_AUTH_URL', canonical);
    for (const path of ['/', '/sign-in?client_id=x&sig=a%2Bb', '/consent?sig=y', '/app', '/app/computer', '/account']) {
      const response = visit(`https://alias.example.test${path}`, { cookie: session });
      expect(response.status, path).toBe(307);
      expect(response.headers.get('location'), path).toBe(`${canonical}${path}`);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    vi.stubEnv('APP_ENV', 'preview');
    expect(visit('https://alias.example.test/sign-in').headers.get('location')).toBeNull();
  });

  it('sends visitors with a session cookie from / to the app and shows everyone else the landing page or sign-in', () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('BETTER_AUTH_URL', canonical);
    for (const cookie of [session, '__Secure-better-auth.session_token=synthetic']) {
      const response = visit(`${canonical}/`, { cookie });
      expect(response.status).toBe(307);
      expect(new URL(response.headers.get('location')!).pathname).toBe('/app');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    for (const cookie of [undefined, 'unrelated=1']) {
      const response = visit(`${canonical}/`, { cookie });
      expect(new URL(response.headers.get('x-middleware-rewrite')!).pathname).toBe('/home');
      const toSignIn = signIn(request(`${canonical}/`, { cookie }));
      expect(toSignIn.status).toBe(307);
      expect(toSignIn.headers.get('location')).toBe(`${canonical}/sign-in`);
      expect(toSignIn.headers.get('cache-control')).toBe('no-store');
    }
    expect(new URL(signIn(request(`${canonical}/`, { cookie: session })).headers.get('location')!).pathname).toBe(
      '/app',
    );
    // Only / routes on the session; other pages and non-GET requests pass through.
    expect(visit(`${canonical}/home`, { cookie: session }).headers.get('location')).toBeNull();
    expect(visit(`${canonical}/`, { cookie: session, method: 'POST' }).headers.get('location')).toBeNull();
    expect(visit(`${canonical}/app`, { cookie: session }).headers.get('location')).toBeNull();
  });

  it('moves the old account and live view addresses to their pages in the app for good, signed in or not', () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('BETTER_AUTH_URL', canonical);
    for (const [from, to] of [
      ['/account', '/app'],
      ['/computer', '/app/computer'],
      ['/computer?x=1', '/app/computer?x=1'],
    ] as const)
      for (const cookie of [session, undefined]) {
        const response = visit(`${canonical}${from}`, { cookie });
        expect(response.status, from).toBe(308);
        expect(response.headers.get('location'), from).toBe(`${canonical}${to}`);
      }
  });
});
