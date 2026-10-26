import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { serverOriginOf } from '../apps/extension/src/origin';
import { compareVersions } from '../packages/capture/src/index';

// Usage: check-extension [unpacked build folder], by default the local build. It checks the build targets
// WXT_SERVER_ORIGIN, or the extension's default origin, as the build itself does.
const extensionDir = path.join(import.meta.dirname, '../apps/extension');
const output = process.argv[2] ?? path.join(extensionDir, '.output/chrome-mv3');
// Pinned in the extension's wxt.config.ts; the server allows this origin in EXTENSION_ORIGINS.
const extensionId = 'jpkiadcbmdldnjmfdllbiioieajicacg';
const serverOrigin = serverOriginOf(process.env.WXT_SERVER_ORIGIN);
const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions.toSorted(), ['activeTab', 'alarms', 'cookies', 'storage']);
assert.deepEqual(manifest.optional_host_permissions.toSorted(), ['http://*/*', 'https://*/*']);
// No install-time site: the extension reaches the server with OAuth tokens.
assert.equal(manifest.host_permissions, undefined);
// Builds from 26.1026.1 connect to other servers too. The web app offers the latest release, which may predate that,
// so an older build is checked as it was released: its own server only.
const otherServers = compareVersions(manifest.version, '26.1026.1') >= 0;
// Only the OAuth redirect page, reachable from the build's server and any HTTPS server or identity provider (before
// other servers, the build's server and Google's sign-in).
assert.deepEqual(manifest.web_accessible_resources, [
  {
    resources: ['connected.html'],
    matches: [`${serverOrigin}/*`, otherServers ? 'https://*/*' : 'https://accounts.google.com/*'],
  },
]);
if (otherServers) {
  assert.deepEqual(manifest.storage, { managed_schema: 'managed-schema.json' });
  const policy = JSON.parse(await readFile(path.join(output, 'managed-schema.json'), 'utf8'));
  assert.equal(policy.properties.approvedServers.type, 'array', 'Policy schema missing approvedServers');
}
for (const forbidden of ['content_scripts', 'externally_connectable'])
  assert.equal(manifest[forbidden], undefined, `Unexpected manifest capability: ${forbidden}`);
assert.equal(manifest.incognito, 'not_allowed');
assert.equal(manifest.minimum_chrome_version, '130');
assert.equal(
  manifest.content_security_policy.extension_pages,
  `script-src 'self'; object-src 'none'; connect-src ${serverOrigin}${otherServers ? ' https:' : ''}`,
);
assert.equal(typeof manifest.key, 'string', 'Pinned public key missing');
const derivedId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)]
  .map(digit => String.fromCharCode(97 + Number.parseInt(digit, 16)))
  .join('');
assert.equal(derivedId, extensionId, 'Pinned key does not produce the allowed extension ID');
const files = await readdir(output, { recursive: true });
assert.ok(!files.some(file => /\.map$/.test(file)), 'Production sourcemaps should not ship');
let originBuilt = false;
for (const file of files.filter(file => /\.(js|html)$/.test(file))) {
  const text = await readFile(path.join(output, file), 'utf8');
  assert.ok(
    !/synthetic-host|fixture-only-sensitive-marker|BEGIN (?:RSA |EC )?PRIVATE KEY|cookies\.(?:set|remove)\(/.test(text),
    `Unexpected data or cookie mutation in ${file}`,
  );
  // No request carries cookies: with no grant on the server, credentialed CORS fails.
  assert.ok(!/credentials:\s*["']include["']/.test(text), `Credentialed request in ${file}`);
  originBuilt ||= text.includes(serverOrigin);
}
assert.ok(originBuilt, 'Server origin in the bundle does not match the manifest CSP');
console.log(
  `PASS: MV3 permissions, pinned ID ${extensionId}, CSP connect-src ${serverOrigin}${otherServers ? ' and HTTPS' : ' only'}, OAuth redirect page, packaging, and credential/fixture guards.`,
);
