import { getSessionCookie } from 'better-auth/cookies';
import { type NextRequest, NextResponse } from 'next/server';
import { canonicalAuthUrl } from './lib/canonical-auth';

const redirect = (target: URL) => {
  const response = NextResponse.redirect(target, 307);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
};

// Where the signed-in pages lived before /app. Installed extensions and old links still use these, so they redirect
// for good; the browser keeps the hash, which the overview follows to the right page.
export const moved: Record<string, string> = { '/account': '/app', '/computer': '/app/computer' };

// Every product page that sets or reads auth cookies: / (which routes on them), sign-in, consent, the app, and the old
// addresses of its pages. Next.js reads an app's matcher only as a literal in its own proxy.ts, so each app writes it
// out, covering at least these.
export const productMatcher = [
  '/',
  '/sign-in',
  '/consent',
  '/app',
  '/app/:path*',
  '/account',
  '/computer',
  '/api/auth/oauth2/authorize',
];

// What a signed-out visitor to / sees: sign-in, or a deployment's own landing page at another path.
export type SignedOut = { redirect: string } | { rewrite: string };

// The app's proxy: the canonical origin first, then the moved pages, then / by session cookie.
export function createProductProxy({ signedOut }: { signedOut: SignedOut }) {
  return function proxy(request: NextRequest) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return NextResponse.next();
    const target = canonicalAuthUrl(request.url, process.env.APP_ENV, process.env.BETTER_AUTH_URL);
    if (target) return redirect(target);
    const { pathname, search } = request.nextUrl;
    const page = moved[pathname];
    if (page) return NextResponse.redirect(new URL(`${page}${search}`, request.url), 308);
    if (pathname !== '/') return NextResponse.next();
    // Signed-in visitors start in the app. Only the cookie's presence is checked here; the app validates the session
    // and sends a stale one to /sign-in.
    if (getSessionCookie(request)) return redirect(new URL('/app', request.url));
    if ('rewrite' in signedOut) return NextResponse.rewrite(new URL(signedOut.rewrite, request.url));
    return redirect(new URL(signedOut.redirect, request.url));
  };
}
