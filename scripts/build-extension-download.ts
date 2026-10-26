// Build step: choose the manual build a web app's Browser sync page offers for loading unpacked, and record its version
// and URL for the app's next.config.ts to read. For the --release-origin, the origin release zips are built for, it is
// the latest release's zip, downloaded straight from GitHub, so it costs the app no bandwidth and is the release's
// reproducible bytes, and only released versions are offered. Other origins (local, self-hosted), or a release without
// one, get a build for this origin written to --out, the app's public/downloads (served at /downloads). Either way the
// zip holds one folder, keeps the pinned key, and passes check-extension first. Paths in this repository resolve from
// this file, so it runs from any directory; --out and --record resolve from the working directory.
// Usage: build-extension-download --out <app>/public/downloads --record <app>/.extension-download.json
//        [--release-origin <origin>]
// The origin is WXT_SERVER_ORIGIN, else BETTER_AUTH_URL, else the release origin, else the extension's default.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { unzipSync } from 'fflate';
import { serverOriginOf } from '../apps/extension/src/origin';

const root = path.join(import.meta.dirname, '..');
const extensionDir = path.join(root, 'apps/extension');
const checkExtension = path.join(import.meta.dirname, 'check-extension.ts');
const releases = 'https://github.com/agent-computers/clutchbox/releases';

const { values } = parseArgs({
  options: { out: { type: 'string' }, record: { type: 'string' }, 'release-origin': { type: 'string' } },
});
if (!values.out || !values.record) {
  console.error(
    'Usage: build-extension-download --out <app>/public/downloads --record <app>/.extension-download.json ' +
      '[--release-origin <origin>]',
  );
  process.exit(2);
}
const downloads = path.resolve(values.out);
const record = path.resolve(values.record);
const releaseOrigin = values['release-origin'] && new URL(values['release-origin']).origin;
const origin = serverOriginOf(process.env.WXT_SERVER_ORIGIN || process.env.BETTER_AUTH_URL || releaseOrigin);
const env = { ...process.env, WXT_SERVER_ORIGIN: origin };
const run = (command: string[], cwd?: string) => {
  const result = spawnSync(command[0]!, command.slice(1), { stdio: 'inherit', env, cwd });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const download = (version: string) => `${releases}/download/v${version}/agent-computers-${version}-chrome-manual.zip`;

// The latest release's version, from where GitHub redirects /releases/latest (no API rate limit), and its manual zip.
async function latestRelease() {
  const latest = await fetch(`${releases}/latest`, { redirect: 'manual' });
  const version = /\/releases\/tag\/v([\d.]+)$/.exec(latest.headers.get('location') ?? '')?.[1];
  if (!version) throw new Error(`No latest release (HTTP ${latest.status})`);
  const asset = await fetch(download(version));
  if (!asset.ok) throw new Error(`Release v${version} has no manual zip (HTTP ${asset.status})`);
  return { version, zip: new Uint8Array(await asset.arrayBuffer()), url: download(version) };
}

let manual: { version: string; zip: Uint8Array; url?: string } | undefined;
if (origin === releaseOrigin)
  try {
    manual = await latestRelease();
    console.log(`Serving the manual build from release v${manual.version}.`);
  } catch (error) {
    // Deploys go on with a local build rather than fail; the warning shows in the build log.
    console.warn(`Warning: building the manual build here instead of serving a release's: ${(error as Error).message}`);
  }
if (!manual) {
  run(['bun', 'run', 'zip:manual'], root);
  const { version } = JSON.parse(await readFile(path.join(extensionDir, 'package.json'), 'utf8'));
  manual = {
    version,
    zip: await readFile(path.join(extensionDir, `.output/agent-computers-${version}-chrome-manual.zip`)),
  };
}

// Check what is about to be offered, not what was built.
const unpacked = await mkdtemp(path.join(tmpdir(), 'manual-'));
for (const [name, data] of Object.entries(unzipSync(manual.zip))) {
  if (name.endsWith('/')) continue;
  const relative = name.replace(/^agent-computers-extension\//, '');
  if (relative === name || relative.split('/').includes('..')) throw new Error(`Unexpected path in the zip: ${name}`);
  await mkdir(path.dirname(path.join(unpacked, relative)), { recursive: true });
  await writeFile(path.join(unpacked, relative), data);
}
const manifest = JSON.parse(await readFile(path.join(unpacked, 'manifest.json'), 'utf8'));
if (manifest.version !== manual.version) throw new Error(`The zip is ${manifest.version}, not ${manual.version}`);
// The same Node and TypeScript loader this script runs under, from whatever directory.
run([process.execPath, ...process.execArgv, checkExtension, unpacked]);
await rm(unpacked, { recursive: true });

await rm(downloads, { recursive: true, force: true });
let url = manual.url;
if (!url) {
  await mkdir(downloads, { recursive: true });
  await writeFile(path.join(downloads, `agent-computers-extension-${manual.version}.zip`), manual.zip);
  url = `/downloads/agent-computers-extension-${manual.version}.zip`;
}
await writeFile(record, `${JSON.stringify({ version: manual.version, url })}\n`);
console.log(`Offering the manual build of ${manual.version} for ${origin} at ${url}.`);
