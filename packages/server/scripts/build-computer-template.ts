// Builds the E2B templates for main computers, one per size, from the E2B adapter's recipe (packages/e2b/src/template.ts).
// Requires E2B_API_KEY (or the E2B CLI login).
// Usage: bun run computer:template
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildComputerTemplate } from '@agent-computers/e2b/template';
import { defaultBuildLogger } from 'e2b';

if (!process.env.E2B_API_KEY) {
  const cli = JSON.parse(await readFile(join(homedir(), '.e2b', 'config.json'), 'utf8').catch(() => '{}'));
  if (cli.projectApiKey) process.env.E2B_API_KEY = cli.projectApiKey;
}
console.log(JSON.stringify(await buildComputerTemplate(undefined, { onBuildLogs: defaultBuildLogger() })));
