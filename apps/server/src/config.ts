import { z } from 'zod';

// Everything the server needs, from the environment. Secrets are compared or used as keys, never logged.
const configSchema = z.object({
  // Where the extension reaches this server: its build's WXT_SERVER_ORIGIN. HTTPS, except on localhost.
  PUBLIC_URL: z.url().transform(url => new URL(url).origin),
  // The extension builds allowed to connect, as chrome-extension://<id>, comma separated.
  EXTENSION_ORIGINS: z
    .string()
    .transform(value =>
      value
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^chrome-extension:\/\/[a-p]{32}$/)).min(1)),
  // Entered on the connect page to connect a browser.
  ACCESS_KEY: z.string().min(16),
  // Bearer key for agents and computers that read the latest capture (GET /api/v1/capture).
  API_KEY: z.string().min(16),
  // 32 bytes, base64: seals the stored capture and settings.
  CAPTURE_ENCRYPTION_KEY: z
    .string()
    .transform(value => Buffer.from(value, 'base64'))
    .refine(key => key.length === 32, 'must be 32 bytes, base64'),
  // The account email the extension shows.
  OWNER_EMAIL: z.string().min(1).default('owner@localhost'),
  DATA_DIR: z.string().min(1).default('./data'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
});
export type Config = z.infer<typeof configSchema>;

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
    );
  const url = new URL(parsed.data.PUBLIC_URL);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')
    throw new Error('PUBLIC_URL must use HTTPS');
  return parsed.data;
}
