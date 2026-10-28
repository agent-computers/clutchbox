import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extensionIds, extensionStatus } from './extension';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'clutchbox-chrome-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const settings = (...ids: string[]) =>
  JSON.stringify({ extensions: { settings: Object.fromEntries(ids.map(id => [id, { state: 1 }])) } });
async function profile(dir: string, name: string, files: Record<string, string>) {
  await mkdir(join(root, dir, name), { recursive: true });
  for (const [file, content] of Object.entries(files)) await writeFile(join(root, dir, name, file), content);
}
const status = (...dirs: string[]) => extensionStatus(dirs.map(dir => join(root, dir)));

describe('extensionStatus', () => {
  it('finds either build in any profile of any channel', async () => {
    await profile('Chrome', 'Default', { 'Secure Preferences': settings('another') });
    await profile('Chrome Beta', 'Profile 2', { Preferences: settings(extensionIds[1] as string) });
    expect(await status('Chrome', 'Chrome Beta')).toBe('installed');
  });

  it('is missing only when every profile was read and none lists it', async () => {
    await profile('Chrome', 'Default', { 'Secure Preferences': settings('another'), Preferences: '{}' });
    await profile('Chrome', 'Profile 1', { Preferences: settings() });
    await mkdir(join(root, 'Chrome', 'Crashpad'));
    expect(await status('Chrome')).toBe('missing');
  });

  it('is unknown without Chrome, or with preferences it cannot parse', async () => {
    expect(await status('Chrome')).toBe('unknown');
    await profile('Chrome', 'Default', { Preferences: '{"extensions":' });
    expect(await status('Chrome')).toBe('unknown');
  });
});
