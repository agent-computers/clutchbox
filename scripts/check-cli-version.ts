// CI: CLI code changed since the base commit needs a new version in packages/cli/package.json, since a push to main
// publishes `clutchbox` to npm only when its version is new (publish-cli.yml). Without a bump, the change would
// reach main and never reach `npx clutchbox@latest`.
// Usage: check-cli-version <base commit>. Tests and docs are not counted.
import { execFileSync } from 'node:child_process';
import { compareVersions } from '../packages/capture/src/index';

// What `bun build` bundles into dist/clutchbox.js: the CLI's source, and the agents' commands it shares with the
// Agents page. publish-cli.yml's `paths` lists the same.
const cliSources = ['packages/cli/src', 'packages/server/src/agents.ts'];

const base = process.argv[2];
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });
if (!base || /^0+$/.test(base)) {
  console.log('No base commit; skipping the CLI version check.');
  process.exit(0);
}
const version = (commit: string) => {
  try {
    return JSON.parse(git('show', `${commit}:packages/cli/package.json`)).version as string;
  } catch {
    return undefined;
  }
};
const [before, after] = [version(base), version('HEAD')];
if (!after) {
  console.error('packages/cli/package.json is missing.');
  process.exit(1);
}
if (!before) {
  console.log(`The CLI is new since ${base}; it starts at ${after}.`);
  process.exit(0);
}
const changed = git('diff', '--name-only', base, 'HEAD', '--', ...cliSources)
  .split('\n')
  .filter(file => file && !/\.(test\.ts|md)$/.test(file));
if (before !== after && (!/^\d+\.\d+\.\d+$/.test(after) || compareVersions(after, before) <= 0)) {
  console.error(`CLI version ${after} must be MAJOR.MINOR.PATCH and newer than ${before}.`);
  process.exit(1);
}
if (changed.length && before === after) {
  console.error(`CLI code changed without a version bump (still ${after}):`);
  for (const file of changed) console.error(`  ${file}`);
  process.exit(1);
}
console.log(changed.length ? `CLI version ${before} -> ${after}.` : 'No CLI code changed.');
