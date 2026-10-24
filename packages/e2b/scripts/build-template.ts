// Builds the computer template into your E2B team. Requires E2B_API_KEY; set E2B_COMPUTER_TEMPLATE to name it.
// Usage: bun run --cwd packages/e2b build-template
import { defaultBuildLogger } from 'e2b';
import { buildComputerTemplate } from '../src/template';

console.log(JSON.stringify(await buildComputerTemplate(undefined, { onBuildLogs: defaultBuildLogger() })));
