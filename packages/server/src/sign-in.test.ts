import { createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth, getPrincipal, resumeAuthorization } from './auth';
import { authorizeBrowser } from './browser-fixtures';
import { ensureExtensionClient } from './browsers';
import type { ServerConfig } from './config';
import type { Database } from './database';
import type { Email } from './mail';
import * as schema from './schema';

// Sign-in with each configured method, through Better Auth's real endpoints: OIDC against a stub issuer, GitHub against
// a stub of its API, and email links through a fake mail sender. Google is Better Auth's own provider, like GitHub.
const origin = 'http://localhost:3097';
const issuer = 'https://idp.example.test';
const extension = `chrome-extension://${'c'.repeat(32)}`;
const config: ServerConfig = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/synthetic',
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'synthetic-only',
  GITHUB_CLIENT_ID: 'synthetic-github-client',
  GITHUB_CLIENT_SECRET: 'synthetic-only',
  OIDC_ISSUER: issuer,
  OIDC_CLIENT_ID: 'synthetic-oidc-client',
  OIDC_CLIENT_SECRET: 'synthetic-only',
  OIDC_NAME: 'Example SSO',
  SMTP_URL: 'smtp://smtp.example.test',
  SMTP_FROM: 'sign-in@example.test',
};

// The stub issuer: discovery, keys, and a token endpoint that answers with the ID token the test chose.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic', alg: 'RS256', use: 'sig' };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function idToken(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: 'RS256', kid: 'synthetic', typ: 'JWT' })}.${encode({
    iss: issuer,
    aud: config.OIDC_CLIENT_ID,
    iat: now,
    exp: now + 300,
    ...claims,
  })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}
let claims: Record<string, unknown> = {};
// GitHub's answers: the member's profile and their addresses, with whether each is verified.
let gitHubUser: { profile: Record<string, unknown>; emails: { email: string; primary: boolean; verified: boolean }[] };
const issuerFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.href === 'https://github.com/login/oauth/access_token')
    return Response.json({
      access_token: 'synthetic-github-access',
      token_type: 'bearer',
      scope: 'read:user,user:email',
    });
  if (url.href === 'https://api.github.com/user') return Response.json(gitHubUser.profile);
  if (url.href === 'https://api.github.com/user/emails') return Response.json(gitHubUser.emails);
  if (url.origin !== issuer) throw new Error(`unexpected fetch ${url}`);
  if (url.pathname === '/.well-known/openid-configuration')
    return Response.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/jwks`,
      id_token_signing_alg_values_supported: ['RS256'],
    });
  if (url.pathname === '/jwks') return Response.json({ keys: [jwk] });
  if (url.pathname === '/token' && init?.method === 'POST')
    return Response.json({
      access_token: 'synthetic-access',
      token_type: 'Bearer',
      expires_in: 300,
      id_token: idToken(claims),
    });
  return new Response('not found', { status: 404 });
};

let pg: PGlite;
let db: Database;
let auth: ReturnType<typeof createAuth>;
let sent: Email[];
let template: PGlite;
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
beforeAll(async () => {
  template = new PGlite();
  const templateDb = drizzle(template, { schema });
  await migrate(templateDb, { migrationsFolder });
  await ensureExtensionClient(templateDb as unknown as Database, extension);
});
afterAll(() => template.close());
beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(issuerFetch));
  pg = (await template.clone()) as PGlite;
  db = drizzle(pg, { schema }) as unknown as Database;
  await db.insert(schema.installation).values({ dataClass: 'nonproduction' });
  sent = [];
  auth = createAuth(db, config, { sendEmail: async email => void sent.push(email) });
  await auth.$context;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await pg.close();
});

// The cookies a response sets, as a request's cookie header.
const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map(cookie => cookie.split(';')[0]!)
    .filter(cookie => !cookie.endsWith('='))
    .join('; ');
function post(path: string, body: unknown, ip = '198.51.100.1') {
  return auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    }),
  );
}
const get = (url: string, cookie = '') =>
  auth.handler(new Request(new URL(url, origin), { headers: cookie ? { cookie } : {} }));
const redirectOf = (response: Response) => {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!, origin);
  return { location, path: `${location.pathname}${location.search}` };
};
const sessionOf = (cookie: string) => getPrincipal(auth, new Headers({ cookie }));
async function existingUser(email: string, providerId = 'google') {
  const id = randomUUID();
  await db.insert(schema.user).values({ id, name: 'Existing', email, emailVerified: true });
  await db.insert(schema.account).values({ id: randomUUID(), userId: id, providerId, accountId: `${providerId}-1` });
  return id;
}

// Starts an OIDC sign-in, has the issuer answer with `idClaims`, and returns the callback's response.
async function signInWithOidc(idClaims: Record<string, unknown>, body: Record<string, unknown> = {}) {
  const started = await post('/sign-in/social', {
    provider: 'oidc',
    callbackURL: '/app',
    errorCallbackURL: '/sign-in',
    ...body,
  });
  expect(started.status).toBe(200);
  const authorization = new URL((await started.json()).url);
  claims = { nonce: authorization.searchParams.get('nonce'), ...idClaims };
  const state = authorization.searchParams.get('state')!;
  return {
    authorization,
    callback: await get(`/api/auth/callback/oidc?code=synthetic&state=${state}`, cookiesOf(started)),
  };
}
// Asks for an email link and returns the URL the email carries.
async function emailLink(email: string, body: Record<string, unknown> = {}, ip?: string) {
  const response = await post(
    '/sign-in/magic-link',
    { email, callbackURL: '/app', errorCallbackURL: '/sign-in', ...body },
    ip,
  );
  expect(response.status).toBe(200);
  return /https?:\/\/\S+/.exec(sent.at(-1)!.text)![0];
}

describe('OIDC sign-in', () => {
  it('signs in with a verified email from the identity provider, asking which account', async () => {
    const { authorization, callback } = await signInWithOidc({
      sub: 'member-1',
      email: 'Member@Example.test',
      email_verified: true,
      name: 'Member',
    });
    expect(authorization.origin + authorization.pathname).toBe(`${issuer}/authorize`);
    expect(authorization.searchParams.get('prompt')).toBe('select_account');
    expect(authorization.searchParams.get('code_challenge')).toBeTruthy();
    expect(authorization.searchParams.get('redirect_uri')).toBe(`${origin}/api/auth/callback/oidc`);
    expect(redirectOf(callback).path).toBe('/app');
    expect(await sessionOf(cookiesOf(callback))).toMatchObject({ email: 'member@example.test', name: 'Member' });
    const [account] = await db.select().from(schema.account).where(eq(schema.account.providerId, 'oidc'));
    expect(account?.accountId).toBe('member-1');
  });
  it('makes no account for an email the identity provider has not verified', async () => {
    for (const email_verified of [false, undefined]) {
      const { callback } = await signInWithOidc({
        sub: 'unverified',
        email: 'unverified@example.test',
        email_verified,
      });
      const { location } = redirectOf(callback);
      expect(location.pathname).toBe('/sign-in');
      expect(location.searchParams.get('error')).toBe('email_not_verified');
      expect(
        callback.headers
          .getSetCookie()
          .some(cookie => cookie.includes('session_token=') && !cookie.includes('session_token=;')),
      ).toBe(false);
    }
    expect(await db.select().from(schema.user)).toEqual([]);
  });
  it('refuses an address whose account signs in another way, without linking it', async () => {
    const id = await existingUser('taken@example.test');
    const { callback } = await signInWithOidc({ sub: 'other', email: 'taken@example.test', email_verified: true });
    expect(redirectOf(callback).location.searchParams.get('error')).toBe('account_not_linked');
    expect(
      (await db.select().from(schema.account).where(eq(schema.account.userId, id))).map(row => row.providerId),
    ).toEqual(['google']);
  });
  it('rejects an ID token the issuer did not sign or that answers another sign-in', async () => {
    const forged = await signInWithOidc({
      sub: 'member-1',
      email: 'member@example.test',
      email_verified: true,
      nonce: 'replayed',
    });
    expect(redirectOf(forged.callback).location.searchParams.get('error')).toBeTruthy();
    expect(await db.select().from(schema.user)).toEqual([]);
  });
});

describe('GitHub sign-in', () => {
  async function signInWithGitHub() {
    const started = await post('/sign-in/social', {
      provider: 'github',
      callbackURL: '/app',
      errorCallbackURL: '/sign-in',
    });
    const authorization = new URL((await started.json()).url);
    expect(authorization.searchParams.get('prompt')).toBe('select_account');
    const state = authorization.searchParams.get('state')!;
    return get(`/api/auth/callback/github?code=synthetic&state=${state}`, cookiesOf(started));
  }
  it('signs in with the address GitHub has verified, and makes no account for one it has not', async () => {
    gitHubUser = {
      profile: { id: 7, login: 'member', name: null, email: null },
      emails: [
        { email: 'old@example.test', primary: false, verified: true },
        { email: 'member@example.test', primary: true, verified: false },
      ],
    };
    expect(redirectOf(await signInWithGitHub()).location.searchParams.get('error')).toBe('email_not_verified');
    expect(await db.select().from(schema.user)).toEqual([]);
    gitHubUser.emails[1]!.verified = true;
    const signedIn = await signInWithGitHub();
    expect(redirectOf(signedIn).path).toBe('/app');
    expect(await sessionOf(cookiesOf(signedIn))).toMatchObject({ email: 'member@example.test', name: 'member' });
  });
});

describe('email link sign-in', () => {
  it('signs in once with the link the email carries, verifying the address', async () => {
    const link = await emailLink('Member@Example.test');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'Member@Example.test', subject: 'Sign in to Clutchbox' });
    const signedIn = await get(link);
    expect(redirectOf(signedIn).path).toBe('/app');
    expect(await sessionOf(cookiesOf(signedIn))).toMatchObject({ email: 'member@example.test' });
    const [user] = await db.select().from(schema.user);
    expect(user?.emailVerified).toBe(true);
    // The token is stored hashed, and works once.
    const stored = await db
      .select()
      .from(schema.verification)
      .where(like(schema.verification.identifier, 'magic-link:%'));
    expect(stored).toEqual([]);
    const again = redirectOf(await get(link));
    expect(again.location.pathname).toBe('/sign-in');
    expect(again.location.searchParams.get('error')).toBe('INVALID_TOKEN');
  });
  it('refuses an expired or altered link', async () => {
    const link = await emailLink('member@example.test');
    const [pending] = await db
      .select()
      .from(schema.verification)
      .where(like(schema.verification.identifier, 'magic-link:%'));
    expect(pending!.identifier).not.toContain(new URL(link).searchParams.get('token'));
    const altered = new URL(link);
    altered.searchParams.set('token', `${altered.searchParams.get('token')}x`);
    expect(redirectOf(await get(altered.toString())).location.searchParams.get('error')).toBe('INVALID_TOKEN');
    await db
      .update(schema.verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.verification.id, pending!.id));
    expect(redirectOf(await get(link)).location.searchParams.get('error')).toBe('INVALID_TOKEN');
    expect(await db.select().from(schema.user)).toEqual([]);
  });
  it('signs an existing account in by its address, whichever way it was made', async () => {
    const id = await existingUser('member@example.test');
    const signedIn = await get(await emailLink('member@example.test'));
    expect(await sessionOf(cookiesOf(signedIn))).toMatchObject({ id });
    expect(await db.select().from(schema.user)).toHaveLength(1);
  });
  it('limits links per address across IPs, and per IP across addresses', async () => {
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) await emailLink('member@example.test', {}, ip);
    const flooded = await post(
      '/sign-in/magic-link',
      { email: 'MEMBER@example.test', callbackURL: '/app' },
      '198.51.100.4',
    );
    expect(flooded.status).toBe(429);
    expect(sent).toHaveLength(3);
    expect(
      (await post('/sign-in/magic-link', { email: 'other@example.test', callbackURL: '/app' }, '198.51.100.4')).status,
    ).toBe(200);
    const statuses = [];
    for (let i = 0; i < 6; i++)
      statuses.push(
        (await post('/sign-in/magic-link', { email: `member${i}@example.test`, callbackURL: '/app' }, '203.0.113.9'))
          .status,
      );
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe('a sign-in mid-connect', () => {
  // The extension's authorize request while signed out, which sends the member to sign in.
  async function signInRequest() {
    const { response, verifier } = await authorizeBrowser(auth, '', { extensionOrigin: extension });
    const { location } = redirectOf(response);
    expect(location.pathname).toBe('/sign-in');
    return { search: location.searchParams, verifier };
  }
  const resume = (cookie: string, search: URLSearchParams) =>
    resumeAuthorization(auth, new Headers({ cookie }), search);

  it('comes back to the sign-in page from an email link and continues the authorize request', async () => {
    const { search } = await signInRequest();
    // The OAuth client plugin sends the page's signed query with the request.
    const link = await emailLink('member@example.test', { oauth_query: search.toString() });
    expect(new URL(link).searchParams.get('callbackURL')).toBe(`/sign-in?${search}`);
    const signedIn = await get(link);
    const back = redirectOf(signedIn).location;
    expect(back.pathname).toBe('/sign-in');
    const cookie = cookiesOf(signedIn);
    const next = await resume(cookie, back.searchParams);
    expect(next).toMatch(/^\/api\/auth\/oauth2\/authorize\?/);
    expect(new URL(next!, origin).searchParams.has('sig')).toBe(false);
    const authorized = redirectOf(await get(next!, cookie)).location;
    expect(`${authorized.protocol}//${authorized.host}${authorized.pathname}`).toBe(`${extension}/connected.html`);
    expect(authorized.searchParams.get('code')).toBeTruthy();
  });
  it('comes back from OIDC the same way', async () => {
    const { search } = await signInRequest();
    const { callback } = await signInWithOidc(
      { sub: 'member-1', email: 'member@example.test', email_verified: true },
      { oauth_query: search.toString() },
    );
    const back = redirectOf(callback);
    expect(back.path).toBe(`/sign-in?${search}`);
    expect(await resume(cookiesOf(callback), back.location.searchParams)).toMatch(/^\/api\/auth\/oauth2\/authorize\?/);
  });
  it('does not continue for a session older than the request, or an altered request', async () => {
    const signedIn = await get(await emailLink('member@example.test'));
    const cookie = cookiesOf(signedIn);
    const { search } = await signInRequest();
    expect(await resume(cookie, search)).toBeNull();
    const fresh = cookiesOf(await get(await emailLink('member@example.test')));
    const altered = new URLSearchParams(search);
    altered.set('redirect_uri', 'https://evil.test/connected.html');
    expect(await resume(fresh, altered)).toBeNull();
    expect(await resume('', search)).toBeNull();
    // A forged session cookie is no session either.
    const forged = createHmac('sha256', 'not-the-secret').update('token').digest('base64');
    expect(await resume(`better-auth.session_token=token.${forged}`, search)).toBeNull();
  });
});
