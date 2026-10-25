import { describe, expect, it } from 'vitest';
import { readConfig, signInMethods } from './config';

const base = {
  APP_ENV: 'test',
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/synthetic',
  BETTER_AUTH_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'synthetic-only-secret-that-is-32-characters-long',
};
const google = { GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'synthetic-google' };
const github = { GITHUB_CLIENT_ID: 'synthetic-github-id', GITHUB_CLIENT_SECRET: 'synthetic-github' };
const oidc = {
  OIDC_ISSUER: 'https://idp.example.test',
  OIDC_CLIENT_ID: 'synthetic-oidc-id',
  OIDC_CLIENT_SECRET: 'synthetic-oidc',
};
const email = { SMTP_URL: 'smtps://mailer:synthetic-smtp@smtp.example.test', SMTP_FROM: 'sign-in@example.test' };
// The error, which must name variables and never print a value from the environment.
function failure(env: Record<string, string>) {
  try {
    readConfig(env);
  } catch (error) {
    const message = (error as Error).message;
    for (const value of Object.values(env)) if (value.length > 6) expect(message).not.toContain(value);
    return message;
  }
  throw new Error('readConfig accepted the configuration');
}

describe('readConfig sign-in methods', () => {
  it('refuses to start with no sign-in method, naming every way to configure one', () => {
    const message = failure(base);
    expect(message).toMatch(/^No sign-in method is configured/);
    for (const name of ['GOOGLE_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'OIDC_ISSUER', 'SMTP_URL', 'SMTP_FROM'])
      expect(message).toContain(name);
    // Empty variables count as unset.
    expect(failure({ ...base, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' })).toMatch(/^No sign-in method/);
  });
  it('refuses a partly configured method, naming only what is missing', () => {
    expect(failure({ ...base, GOOGLE_CLIENT_ID: google.GOOGLE_CLIENT_ID })).toBe(
      'Google sign-in is partly configured. Set GOOGLE_CLIENT_SECRET too.',
    );
    expect(failure({ ...base, ...google, GITHUB_CLIENT_SECRET: github.GITHUB_CLIENT_SECRET })).toBe(
      'GitHub sign-in is partly configured. Set GITHUB_CLIENT_ID too.',
    );
    expect(failure({ ...base, ...google, OIDC_CLIENT_SECRET: oidc.OIDC_CLIENT_SECRET, OIDC_NAME: 'Acme SSO' })).toBe(
      'OIDC sign-in is partly configured. Set OIDC_ISSUER and OIDC_CLIENT_ID too.',
    );
    expect(failure({ ...base, SMTP_URL: email.SMTP_URL })).toBe(
      'Email link sign-in is partly configured. Set SMTP_FROM too.',
    );
  });
  it('names invalid variables without their values', () => {
    expect(failure({ ...base, ...email, SMTP_URL: 'https://mailer:synthetic-smtp@smtp.example.test' })).toBe(
      'Server configuration is incomplete or invalid. Check SMTP_URL.',
    );
    expect(failure({ ...google, APP_ENV: 'test', BETTER_AUTH_SECRET: 'short-synthetic' })).toBe(
      'Server configuration is incomplete or invalid. Check DATABASE_URL, BETTER_AUTH_URL and BETTER_AUTH_SECRET.',
    );
  });
  it('offers exactly the configured methods, Google alone as before', () => {
    expect(signInMethods(readConfig({ ...base, ...google }))).toEqual({ providers: ['google'], emailLink: false });
    expect(signInMethods(readConfig({ ...base, ...email }))).toEqual({ providers: [], emailLink: true });
    expect(signInMethods(readConfig({ ...base, ...oidc }))).toEqual({
      providers: [{ id: 'oidc', label: 'Single sign-on' }],
      emailLink: false,
    });
    expect(
      signInMethods(readConfig({ ...base, ...google, ...github, ...oidc, ...email, OIDC_NAME: 'Acme SSO' })),
    ).toEqual({ providers: ['google', 'github', { id: 'oidc', label: 'Acme SSO' }], emailLink: true });
  });
});
