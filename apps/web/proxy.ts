import { createProductProxy } from '@clutchbox/web/proxy';

// Signed-out visitors to / go to sign-in.
export const proxy = createProductProxy({ signedOut: { redirect: '/sign-in' } });

// The product's matcher (productMatcher in @clutchbox/web/proxy), written out because Next.js reads it only as
// a literal here.
export const config = {
  matcher: ['/', '/sign-in', '/consent', '/app', '/app/:path*', '/account', '/computer', '/api/auth/oauth2/authorize'],
};
