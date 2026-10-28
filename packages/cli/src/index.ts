#!/usr/bin/env node
import { type SpawnSyncOptions, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { agentAddCommands, mcpServerName } from '@clutchbox/server/agents';
import { chromeWebStoreUrl, extensionStatus } from './extension';
import { serverOrigin } from './server';

// `npx clutchbox`: adds a Clutchbox server to the agents on this machine that have a CLI, then opens the web app's
// setup, which signs the user in and covers browser sync, the steps a terminal can't do, and the Chrome Web Store
// when this machine's Chrome lacks the extension. It holds no credentials: each agent signs in with its own consent,
// as when the user follows the Agents page by hand.
const defaultServer = 'https://www.clutchbox.dev';
const help = `Usage: npx clutchbox@latest [options]

Connects Claude Code and Codex to Clutchbox, then opens setup in your browser.

Options:
  --server <url>  A self-hosted Clutchbox server (default: ${defaultServer})
  --agent         For an AI agent running this for you: no questions, plain steps
  -y, --yes       Don't ask before changing your agents' settings
  -h, --help      Show this help
`;

type Agent = { name: string; bin: string; command: (mcpUrl: string) => string[]; finish: string };
const agents: Agent[] = [
  {
    name: 'Claude Code',
    bin: 'claude',
    command: agentAddCommands['claude-code'],
    finish: `In Claude Code, run /mcp, choose ${mcpServerName}, then Authenticate and allow the connection`,
  },
  // Codex signs in as it adds the server, and `codex mcp login` retries.
  {
    name: 'Codex',
    bin: 'codex',
    command: agentAddCommands.codex,
    finish: `Allow the connection in the page Codex opened, or if none opened, run: codex mcp login ${mcpServerName}`,
  },
];

// npm installs these CLIs as .cmd shims on Windows, which only a shell runs. Every argument is a constant or the
// server's MCP URL, built from a parsed origin, so nothing the shell would interpret reaches it.
function run(command: string[], options: SpawnSyncOptions = {}) {
  const windows = process.platform === 'win32';
  const [file, ...args] = command;
  return windows ? spawnSync(command.join(' '), { shell: true, ...options }) : spawnSync(file as string, args, options);
}

const installed = (agent: Agent) => run([agent.bin, '--version'], { stdio: 'ignore' }).status === 0;

// Set up already when any server the agent lists has our MCP URL, under our name or another, such as a Claude
// connector that Claude Code picks up.
function configured(agent: Agent, mcpUrl: string) {
  const list = run([agent.bin, 'mcp', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return typeof list.stdout === 'string' && list.stdout.includes(mcpUrl);
}

// A machine without a display, such as a remote box an agent runs on, has nowhere to open a page.
const hasDisplay = () => process.platform !== 'linux' || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;

function launch(file: string, args: string[]) {
  try {
    spawn(file, args, { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
    return true;
  } catch {
    return false;
  }
}

function openInBrowser(url: string) {
  if (!hasDisplay()) return false;
  if (process.platform === 'darwin') return launch('open', [url]);
  if (process.platform === 'win32') return launch('cmd', ['/c', 'start', '""', url]);
  return launch('xdg-open', [url]);
}

// The Chrome Web Store installs into the browser that shows it, which must be Chrome, not the default browser. False
// when Chrome can't be found, so the caller opens the default browser instead.
function openInChrome(url: string) {
  if (!hasDisplay()) return false;
  if (process.platform === 'darwin') return spawnSync('open', ['-a', 'Google Chrome', url]).status === 0;
  const candidates =
    process.platform === 'win32'
      ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].flatMap(root =>
          root ? [join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')] : [],
        )
      : (process.env.PATH ?? '')
          .split(delimiter)
          .flatMap(dir => (dir ? ['google-chrome-stable', 'google-chrome'].map(bin => join(dir, bin)) : []));
  const chrome = candidates.find(file => existsSync(file));
  return chrome ? launch(chrome, [url]) : false;
}

async function main() {
  const { values } = parseArgs({
    options: {
      server: { type: 'string', default: defaultServer },
      agent: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  const origin = serverOrigin(values.server);
  const mcpUrl = `${origin}/api/mcp`;
  // An agent's shell has no terminal to answer from, so no terminal means the same as --agent.
  const forAgent = values.agent || !process.stdin.isTTY;
  const yourSteps: string[] = [];
  const say = (line = '') => process.stdout.write(`${line}\n`);

  say(`Clutchbox setup for ${origin}`);
  say();
  say('Agents');
  const found = agents.filter(installed);
  const toAdd = found.filter(agent => {
    if (!configured(agent, mcpUrl)) return true;
    say(`  ✓ ${agent.name} is already connected.`);
    return false;
  });
  if (!found.length) say('  Neither Claude Code nor Codex is installed here.');
  if (toAdd.length && !forAgent && !values.yes) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question(`  Add Clutchbox to ${toAdd.map(agent => agent.name).join(' and ')}? [Y/n] `);
    prompt.close();
    if (/^n/i.test(answer.trim())) toAdd.length = 0;
  }
  for (const agent of toAdd) {
    say(`  Adding Clutchbox to ${agent.name}…`);
    // The agent's own output shows, including any sign-in link it prints.
    const added = run(agent.command(mcpUrl), { stdio: 'inherit' });
    if (added.status === 0) {
      say(`  ✓ ${agent.name} is connected.`);
      yourSteps.push(`${agent.finish}.`);
    } else say(`  ✗ ${agent.name} failed. Run it yourself: ${agent.command(mcpUrl).join(' ')}`);
  }
  say(`  Claude and ChatGPT on the web: follow ${origin}/app/agents`);

  say();
  say('Setup');
  const setupUrl = `${origin}/app`;
  // Only on the machine the user sits at: over SSH or without a display, Chrome here isn't the user's own.
  const extension = hasDisplay() && !process.env.SSH_CONNECTION ? await extensionStatus() : 'unknown';
  // The store build works with the hosted service; a self-hosted server's setup offers the build it accepts.
  const storeUrl = origin === defaultServer && extension === 'missing' ? chromeWebStoreUrl : undefined;
  const opened = !forAgent && openInBrowser(setupUrl);
  say(opened ? `  Opened ${setupUrl}` : `  Open ${setupUrl}`);
  if (extension === 'installed') {
    say('  ✓ The Chrome extension is installed.');
    yourSteps.unshift(`Sign in at ${setupUrl}, connect the Chrome extension, and choose the sites to sync.`);
  } else if (storeUrl) {
    // Opened last, so the store is the tab in front.
    const store = !forAgent && (openInChrome(storeUrl) || openInBrowser(storeUrl));
    say(store ? '  Opened the Chrome Web Store to add the extension' : '  The Chrome extension is not installed.');
    yourSteps.unshift(`Add the Chrome extension: ${storeUrl}`, `Sign in at ${setupUrl} and choose the sites to sync.`);
  } else yourSteps.unshift(`Sign in at ${setupUrl}, add the Chrome extension, and choose the sites to sync.`);

  say();
  say(forAgent ? 'Steps only the user can do (tell them):' : 'Your steps:');
  yourSteps.forEach((step, index) => {
    say(`  ${index + 1}. ${step}`);
  });
  say();
  say('Then ask your agent: "Open my Clutchbox computer and check my GitHub notifications."');
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
