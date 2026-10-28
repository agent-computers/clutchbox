import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type RouteEntry, routeManifest } from '../src/route-manifest';

// Writes an app's product route files from the route manifest (src/route-manifest.ts), or with --check, fails when
// they differ from it. Each file imports its module by package name and the deployment's services by the app's own
// '@/' alias, so the same text wires each app to its own deployment.
//
//   generate-routes --app <app dir> [--group <id>=(<group>),...] [--check]
//
// --group places a route in one of the app's route groups, such as sign-in in an (auth) group with a plain layout, so
// it gets that group's layout.

export const GENERATED = '// Generated from the route manifest in @clutchbox/web (src/route-manifest.ts) by its';
const header = `${GENERATED}\n// generate-routes script. Change the manifest and regenerate rather than editing this file.`;

// The file's text. It must be what Biome would format it to, or `bun run format` and --check disagree.
export function renderRoute(entry: RouteEntry): string {
  const from = `'@clutchbox/web/routes/${entry.module}'`;
  const { factory, aliases = {}, reexport = [], segment = {} } = entry;
  const lines = [header];
  const imported = [...(factory ? [factory.name] : []), ...Object.values(aliases)].sort();
  if (imported.length) lines.push(`import { ${imported.join(', ')} } from ${from};`);
  if (factory) lines.push("import { getServices } from '@/deployment/server';");
  if (factory?.shell) lines.push("import { deployment } from '@/deployment/ui';");
  const config = Object.entries(segment).map(
    ([name, value]) => `export const ${name} = ${typeof value === 'string' ? `'${value}'` : value};`,
  );
  if (config.length) lines.push('', ...config);
  const body: string[] = [];
  if (reexport.length) body.push(`export { ${reexport.join(', ')} } from ${from};`);
  if (factory) {
    const call = `${factory.name}(getServices${factory.shell ? ', deployment.shell' : ''})`;
    const named = Object.entries(aliases).map(([as, name]) => `${name} as ${as}`);
    if (factory.as.length === 1 && factory.as[0] === 'default' && !named.length) body.push(`export default ${call};`);
    else if (factory.as.length === 1 && !named.length) body.push(`export const ${factory.as[0]} = ${call};`);
    else {
      const exports = [...named.sort(), ...factory.as.map(as => `handler as ${as}`)];
      // Biome keeps an export list apart from the statements before it.
      body.push(`const handler = ${call};`, '', `export { ${exports.join(', ')} };`);
    }
  }
  lines.push('', ...body);
  return `${lines.join('\n')}\n`;
}

// --group's value: route id to route group, such as { 'sign-in': '(site)' }.
export function parseGroups(values: string[]): Record<string, string> {
  const groups: Record<string, string> = {};
  for (const pair of values.flatMap(value => value.split(','))) {
    const [id, group] = pair.split('=');
    if (!id || !group || !/^\([\w-]+\)$/.test(group)) throw new Error(`--group expects <id>=(<group>), got ${pair}`);
    if (!routeManifest.some(entry => entry.id === id)) throw new Error(`--group names no route in the manifest: ${id}`);
    groups[id] = group;
  }
  return groups;
}

// The files the manifest gives an app, by path under its app/.
export function routeFiles(groups: Record<string, string> = {}): Map<string, string> {
  return new Map(
    routeManifest.map(entry => {
      const group = groups[entry.id];
      return [join(...(group ? [group] : []), entry.dir, entry.file), renderRoute(entry)];
    }),
  );
}

// What a route file claims: a layout, or the page or handler at a URL, wherever its route groups put it.
const ROUTE_FILE = /^(page|layout|route)\.(js|jsx|ts|tsx|mdx)$/;
const claim = (path: string) => {
  const segments = path.split('/').filter(segment => !/^\(.+\)$/.test(segment));
  const kind = segments.pop()?.startsWith('layout.') ? 'layout' : 'page or route';
  return `${kind} at /${segments.join('/')}`;
};

const listFiles = (root: string, dir = ''): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap(item => (item.isDirectory() ? listFiles(root, join(dir, item.name)) : [join(dir, item.name)]));

// Every way the app's route files differ from the manifest: a missing or changed file, a generated file the manifest
// no longer lists, and a hand-written route that claims a manifest route's URL from another place, such as another
// route group, where Next.js would refuse to build or one would shadow the other.
export function checkApp(appDir: string, groups: Record<string, string> = {}): string[] {
  const appRoot = join(appDir, 'app');
  const expected = routeFiles(groups);
  const claims = new Map([...expected.keys()].map(path => [claim(path), path]));
  const problems: string[] = [];
  for (const [path, text] of expected) {
    let current: string | undefined;
    try {
      current = readFileSync(join(appRoot, path), 'utf8');
    } catch {}
    if (current === undefined) problems.push(`app/${path} is missing`);
    else if (current !== text) problems.push(`app/${path} differs from the manifest`);
  }
  for (const path of listFiles(appRoot)) {
    if (expected.has(path)) continue;
    const name = path.split('/').pop() ?? '';
    if (!/\.(js|jsx|ts|tsx)$/.test(name)) continue;
    if (readFileSync(join(appRoot, path), 'utf8').startsWith(GENERATED))
      problems.push(`app/${path} is generated but no longer in the manifest`);
    else if (ROUTE_FILE.test(name) && claims.has(claim(path)))
      problems.push(`app/${path} claims the ${claim(path)}, which the manifest gives app/${claims.get(claim(path))}`);
  }
  return problems;
}

// Writes the manifest's files and removes generated ones it no longer lists. Hand-written files are left alone, so a
// collision still fails checkApp.
export function writeApp(appDir: string, groups: Record<string, string> = {}): string[] {
  const appRoot = join(appDir, 'app');
  const expected = routeFiles(groups);
  const changed: string[] = [];
  for (const path of listFiles(appRoot))
    if (!expected.has(path) && /\.(js|jsx|ts|tsx)$/.test(path)) {
      if (!readFileSync(join(appRoot, path), 'utf8').startsWith(GENERATED)) continue;
      rmSync(join(appRoot, path));
      changed.push(`removed app/${path}`);
    }
  for (const [path, text] of expected) {
    const file = join(appRoot, path);
    let current: string | undefined;
    try {
      current = readFileSync(file, 'utf8');
    } catch {}
    if (current === text) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    changed.push(`wrote app/${path}`);
  }
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const { values } = parseArgs({
    options: {
      app: { type: 'string' },
      group: { type: 'string', multiple: true, default: [] },
      check: { type: 'boolean', default: false },
    },
  });
  if (!values.app) throw new Error('generate-routes needs --app <app dir>');
  const appDir = resolve(values.app);
  const groups = parseGroups(values.group);
  const name = relative(process.cwd(), appDir) || '.';
  if (values.check) {
    const problems = checkApp(appDir, groups);
    for (const problem of problems) console.error(`${name}: ${problem}`);
    if (problems.length) {
      console.error(
        'Run generate-routes without --check to rewrite them, and move hand-written routes off these URLs.',
      );
      process.exit(1);
    }
    console.log(`${name}: route files match the manifest.`);
  } else {
    const changed = writeApp(appDir, groups);
    for (const line of changed) console.log(`${name}: ${line}`);
    const problems = checkApp(appDir, groups);
    for (const problem of problems) console.error(`${name}: ${problem}`);
    if (problems.length) process.exit(1);
    if (!changed.length) console.log(`${name}: route files already match the manifest.`);
  }
}
