// Packages the manual build: the production extension with its pinned key, for loading unpacked in Developer mode. It
// targets WXT_SERVER_ORIGIN (clutchbox.dev by default), and the zip holds one folder, so unzipping anywhere gives
// the folder Chrome's Load unpacked expects. Writes apps/extension/.output/agent-computers-<version>-chrome-manual.zip.
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
import extension from '../apps/extension/package.json' with { type: 'json' };

const root = path.join(import.meta.dirname, '..');
const output = path.join(root, 'apps/extension/.output/chrome-mv3');
const build = spawnSync('bun', ['run', 'build:extension'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
// A fixed timestamp keeps the zip the same for the same build.
const mtime = new Date('2026-01-01T00:00:00Z');
const files: { [name: string]: [Uint8Array, { mtime: Date }] } = {};
for (const file of await readdir(output, { recursive: true, withFileTypes: true }))
  if (file.isFile()) {
    const full = path.join(file.parentPath, file.name);
    files[`agent-computers-extension/${path.relative(output, full).split(path.sep).join('/')}`] = [
      await readFile(full),
      { mtime },
    ];
  }
const zip = path.join(root, `apps/extension/.output/agent-computers-${extension.version}-chrome-manual.zip`);
await writeFile(zip, zipSync(files));
console.log(`Packaged the manual build of ${extension.version} as ${path.relative(root, zip)}.`);
