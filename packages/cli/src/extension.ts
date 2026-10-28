import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Whether this machine's Chrome has the extension, so setup can send the user to the Chrome Web Store first. Best
// effort: it only reads Chrome's files, and anything it can't tell for sure is `unknown`, which keeps setup's steps
// as they were.

// The store build's ID, which the Chrome Web Store assigned, and the manual build's, which its pinned key fixes.
export const extensionIds = ['bjmfpnkjkdkfimdfgbgepmdgdnodpmmi', 'jpkiadcbmdldnjmfdllbiioieajicacg'];
export const chromeWebStoreUrl =
  'https://chromewebstore.google.com/detail/agent-computers-%E2%80%94-browser/bjmfpnkjkdkfimdfgbgepmdgdnodpmmi';

export type ExtensionStatus = 'installed' | 'missing' | 'unknown';

// Chrome's user data folders, one per release channel. Other Chromium browsers aren't checked, so the extension
// installed only in one of them reads as missing from Chrome.
export function chromeDataDirs(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string[] {
  if (platform === 'darwin')
    return ['Chrome', 'Chrome Beta', 'Chrome Dev', 'Chrome Canary'].map(channel =>
      join(home, 'Library', 'Application Support', 'Google', channel),
    );
  if (platform === 'win32')
    return ['Chrome', 'Chrome Beta', 'Chrome Dev', 'Chrome SxS'].map(channel =>
      join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Google', channel, 'User Data'),
    );
  if (platform === 'linux')
    return ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'google-chrome-canary'].map(channel =>
      join(env.XDG_CONFIG_HOME || join(home, '.config'), channel),
    );
  return [];
}

// Each profile lists its extensions under `extensions.settings`, by ID, in Secure Preferences or Preferences, whether
// enabled or not; uninstalling removes the entry. Null for a file that isn't JSON.
function listsExtension(preferences: string): boolean | null {
  try {
    const settings = JSON.parse(preferences)?.extensions?.settings;
    return typeof settings === 'object' && settings !== null && extensionIds.some(id => Object.hasOwn(settings, id));
  } catch {
    return null;
  }
}

async function readProfiles(dirs: string[]): Promise<ExtensionStatus> {
  let profiles = 0;
  let unreadable = false;
  for (const dir of dirs) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // A profile is a folder with preferences: Default, Profile 1, and so on.
      const files = await Promise.all(
        ['Secure Preferences', 'Preferences'].map(name =>
          readFile(join(dir, entry.name, name), 'utf8').catch(() => null),
        ),
      );
      const found = files.flatMap(file => (file === null ? [] : [listsExtension(file)]));
      if (!found.length) continue;
      profiles++;
      if (found.includes(true)) return 'installed';
      if (found.includes(null)) unreadable = true;
    }
  }
  return profiles && !unreadable ? 'missing' : 'unknown';
}

// Never throws, and gives up as `unknown` after `timeoutMs`, such as on a slow network home folder.
export async function extensionStatus(dirs = chromeDataDirs(), timeoutMs = 2000): Promise<ExtensionStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ExtensionStatus>(resolve => {
    timer = setTimeout(() => resolve('unknown'), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([readProfiles(dirs).catch((): ExtensionStatus => 'unknown'), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
