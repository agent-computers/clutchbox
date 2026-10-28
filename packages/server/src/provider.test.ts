import { randomBytes } from 'node:crypto';
import { e2bComputerProvider, TEMPLATE } from '@clutchbox/e2b';
import { describe, expect, it, vi } from 'vitest';
import { readConfig } from './config';
import { providerFromConfig } from './provider';

vi.mock('@clutchbox/e2b', async original => {
  const actual = await original<typeof import('@clutchbox/e2b')>();
  return { ...actual, e2bComputerProvider: vi.fn(actual.e2bComputerProvider) };
});

const env = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/synthetic',
  BETTER_AUTH_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'synthetic-only',
  NODE_ENV: 'test',
};

describe('providerFromConfig', () => {
  it('runs computers on the configured E2B team and template', () => {
    const config = readConfig({ ...env, E2B_API_KEY: 'synthetic-only', E2B_COMPUTER_TEMPLATE: 'our-template' });
    expect(providerFromConfig({ ...config, APP_ENV: 'production' })).toHaveProperty('revision');
    expect(e2bComputerProvider).toHaveBeenLastCalledWith('our-template');
    providerFromConfig(readConfig({ ...env, E2B_API_KEY: 'synthetic-only', E2B_COMPUTER_TEMPLATE: '' }));
    expect(e2bComputerProvider).toHaveBeenLastCalledWith(TEMPLATE);
  });

  it('uses the in-memory fake without a key outside production, where it is required', () => {
    vi.mocked(e2bComputerProvider).mockClear();
    const config = readConfig({ ...env, E2B_API_KEY: '' });
    expect(config.E2B_API_KEY).toBeUndefined();
    expect(providerFromConfig(config)).toHaveProperty('revision', 'revision-1');
    expect(() => providerFromConfig({ ...config, APP_ENV: 'production' })).toThrow('E2B_API_KEY is required.');
    expect(e2bComputerProvider).not.toHaveBeenCalled();
  });
});
