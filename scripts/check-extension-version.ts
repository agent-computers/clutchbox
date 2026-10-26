// CI: extension code changed since the base commit needs a new version in apps/extension/package.json.
// Users install builds by hand, so two different builds sharing a version would hide an update from them.
// Usage: check-extension-version <base commit>. Docs are not counted.
import { execFileSync } from 'node:child_process';
import { compareVersions } from '../packages/capture/src/index';

const base = process.argv[2];
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });
if (!base || /^0+$/.test(base)) {
  console.log('No base commit; skipping the extension version check.');
  process.exit(0);
}
const version = (commit: string) => {
  try {
    return JSON.parse(git('show', `${commit}:apps/extension/package.json`)).version as string;
  } catch {
    return undefined;
  }
};
const [before, after] = [version(base), version('HEAD')];
if (!after) {
  console.error('apps/extension/package.json is missing.');
  process.exit(1);
}
if (!before) {
  console.log(`The extension is new since ${base}; it starts at ${after}.`);
  process.exit(0);
}
// The capture package ships inside the extension.
const changed = git('diff', '--name-only', base, 'HEAD', '--', 'apps/extension', 'packages/capture/src')
  .split('\n')
  .filter(file => file && !/\.(test\.ts|md)$/.test(file));
// YY.MDD.PATCH: 26.1016.0 is the first release on October 16, 2026 (January 1 is 101); PATCH counts up within a day.
const calendar = /^\d{2}\.(?:[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\.(?:0|[1-9]\d*)$/;
if (before !== after && (!calendar.test(after) || compareVersions(after, before) <= 0)) {
  console.error(`Extension version ${after} must be YY.MDD.PATCH and newer than ${before}.`);
  process.exit(1);
}
if (changed.length && before === after) {
  console.error(`Extension code changed without a version bump (still ${after}):`);
  for (const file of changed) console.error(`  ${file}`);
  process.exit(1);
}
console.log(changed.length ? `Extension version ${before} -> ${after}.` : 'No extension code changed.');
