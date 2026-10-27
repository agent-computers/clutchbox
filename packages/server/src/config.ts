import { z } from 'zod';
import { builtInAgentClientUrls } from './agents';

const optional = z.string().optional();
const envSchema = z.object({
  APP_ENV: z.enum(['development', 'preview', 'production', 'test']),
  DATABASE_URL: z.url().refine(value => ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
  BETTER_AUTH_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  // Sign-in methods (signInMethods): each is on when its variables are set, and at least one must be.
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  GITHUB_CLIENT_ID: optional,
  GITHUB_CLIENT_SECRET: optional,
  // The identity provider's issuer, or its discovery document's URL.
  OIDC_ISSUER: z.url().optional(),
  OIDC_CLIENT_ID: optional,
  OIDC_CLIENT_SECRET: optional,
  // The sign-in button's name for it, such as "Acme SSO".
  OIDC_NAME: optional,
  // Email links: an smtp:// or smtps:// URL with any credentials in it, and the address they come from.
  SMTP_URL: z
    .url()
    .refine(value => ['smtp:', 'smtps:'].includes(new URL(value).protocol))
    .optional(),
  SMTP_FROM: optional,
  // The organization's E2B account for computers (providerFromConfig).
  E2B_API_KEY: optional,
  E2B_COMPUTER_TEMPLATE: optional,
  // Other agents' client_id URLs, comma separated, besides Claude's and ChatGPT's (agentClientUrls).
  AGENT_CLIENT_URLS: optional,
});
export type ServerConfig = z.infer<typeof envSchema>;

// Each sign-in method's variables, all required once any is set (OIDC_NAME is optional).
const methodVariables = {
  Google: { required: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], optional: [] },
  GitHub: { required: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'], optional: [] },
  OIDC: { required: ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'], optional: ['OIDC_NAME'] },
  'Email link': { required: ['SMTP_URL', 'SMTP_FROM'], optional: [] },
} as const satisfies Record<string, { required: (keyof ServerConfig)[]; optional: (keyof ServerConfig)[] }>;
const list = (names: readonly string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

// Errors name variables and never print their values.
export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // An empty variable counts as unset.
  const parsed = envSchema.safeParse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')));
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map(issue => String(issue.path[0])))];
    throw new Error(`Server configuration is incomplete or invalid. Check ${list(names)}.`);
  }
  const config = parsed.data;
  const methods = Object.entries(methodVariables).filter(([, variables]) =>
    [...variables.required, ...variables.optional].some(name => config[name] !== undefined),
  );
  for (const [method, variables] of methods) {
    const missing = variables.required.filter(name => config[name] === undefined);
    if (missing.length) throw new Error(`${method} sign-in is partly configured. Set ${list(missing)} too.`);
  }
  if (!methods.length)
    throw new Error(
      `No sign-in method is configured. Set ${Object.values(methodVariables)
        .map(variables => list(variables.required))
        .join('; or ')}.`,
    );
  const origin = new URL(config.BETTER_AUTH_URL);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/')
    throw new Error('BETTER_AUTH_URL must be an origin.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (
    origin.protocol !== 'https:' &&
    !(loopback && ['development', 'test'].includes(config.APP_ENV) && origin.protocol === 'http:')
  )
    throw new Error('HTTPS is required outside local development.');
  agentClientUrls(config);
  if (env.VERCEL_ENV && env.VERCEL_ENV !== config.APP_ENV) throw new Error('Deployment environment mismatch.');
  if (config.APP_ENV === 'test' && (env.VERCEL || env.NODE_ENV !== 'test'))
    throw new Error('Test configuration cannot run in a deployment.');
  return { ...config, BETTER_AUTH_URL: origin.origin };
}
// The client_id URLs agents may connect with (isAllowedAgentClient): the built-in ones and AGENT_CLIENT_URLS. Each
// added one is an HTTPS URL, matched exactly, or as a prefix when it ends with a slash.
export function agentClientUrls(config: Pick<ServerConfig, 'AGENT_CLIENT_URLS'>): string[] {
  const added = (config.AGENT_CLIENT_URLS ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  for (const entry of added) {
    const url = URL.canParse(entry) ? new URL(entry) : null;
    if (url?.protocol !== 'https:' || url.href !== entry || url.username || url.password || url.search || url.hash)
      throw new Error('AGENT_CLIENT_URLS must list HTTPS client_id URLs, or prefixes ending with a slash.');
  }
  return [...builtInAgentClientUrls, ...added];
}
export const dataClassFor = (environment: ServerConfig['APP_ENV']) =>
  environment === 'production' ? 'production' : 'nonproduction';

// The generic OIDC provider's ID in Better Auth, and so in its redirect URI: <BETTER_AUTH_URL>/api/auth/callback/oidc.
export const OIDC_PROVIDER_ID = 'oidc';
// The sign-in page's methods, from the configuration: OAuth providers in this order, and email links.
export type SignInProvider = 'google' | 'github' | { id: typeof OIDC_PROVIDER_ID; label: string };
export type SignInMethods = { providers: SignInProvider[]; emailLink: boolean };
export function signInMethods(config: ServerConfig): SignInMethods {
  const providers: SignInProvider[] = [];
  if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) providers.push('google');
  if (config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET) providers.push('github');
  if (config.OIDC_ISSUER && config.OIDC_CLIENT_ID && config.OIDC_CLIENT_SECRET)
    providers.push({ id: OIDC_PROVIDER_ID, label: config.OIDC_NAME ?? 'Single sign-on' });
  return { providers, emailLink: Boolean(config.SMTP_URL && config.SMTP_FROM) };
}
