import { z } from 'zod';

const envSchema = z.object({
  APP_ENV: z.enum(['development', 'preview', 'production', 'test']),
  DATABASE_URL: z.url().refine(value => ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
  BETTER_AUTH_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  // The organization's E2B account for computers (providerFromConfig); empty counts as unset.
  E2B_API_KEY: z.string().optional(),
  E2B_COMPUTER_TEMPLATE: z.string().optional(),
});
export type ServerConfig = z.infer<typeof envSchema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success)
    throw new Error('Server configuration is incomplete. Check required environment variable names.');
  const config = parsed.data;
  const origin = new URL(config.BETTER_AUTH_URL);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/')
    throw new Error('BETTER_AUTH_URL must be an origin.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (
    origin.protocol !== 'https:' &&
    !(loopback && ['development', 'test'].includes(config.APP_ENV) && origin.protocol === 'http:')
  )
    throw new Error('HTTPS is required outside local development.');
  if (env.VERCEL_ENV && env.VERCEL_ENV !== config.APP_ENV) throw new Error('Deployment environment mismatch.');
  if (config.APP_ENV === 'test' && (env.VERCEL || env.NODE_ENV !== 'test'))
    throw new Error('Test configuration cannot run in a deployment.');
  return {
    ...config,
    BETTER_AUTH_URL: origin.origin,
    E2B_API_KEY: config.E2B_API_KEY || undefined,
    E2B_COMPUTER_TEMPLATE: config.E2B_COMPUTER_TEMPLATE || undefined,
  };
}
export const dataClassFor = (environment: ServerConfig['APP_ENV']) =>
  environment === 'production' ? 'production' : 'nonproduction';
