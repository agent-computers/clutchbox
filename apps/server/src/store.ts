import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// The server's state: one JSON file, rewritten whole (write, then rename) after every change, so a crash leaves the
// old file or the new one. The capture and the settings are sealed with AES-256-GCM; tokens are kept only as hashes.
// One process owns the file, and every change runs through `update` one at a time.
export type Browser = { createdAt: string; lastSyncedAt?: string | undefined };
export type TokenRecord = {
  kind: 'access' | 'refresh';
  browserId: string;
  expiresAt: number;
  // A refresh token already exchanged for a new pair.
  rotatedAt?: number | undefined;
};
export type StoredCapture = {
  sealed: string;
  digest: string;
  completedAt: string;
  cookieCount: number;
  browserId: string | null;
};
export type State = {
  settings?: string | undefined;
  capture?: StoredCapture | undefined;
  browsers: Record<string, Browser>;
  tokens: Record<string, TokenRecord>;
};

export const hashToken = (token: string) => createHash('sha256').update(token).digest('base64url');
export const randomToken = () => randomBytes(32).toString('base64url');

export function seal(plaintext: string, label: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`agent-computers-self-host/${label}/v1`));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data]
    .map(part => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}
export function open(sealed: string, label: string, key: Buffer) {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('unreadable');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(`agent-computers-self-host/${label}/v1`));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export interface Store {
  read(): State;
  // Runs `change` on a copy of the state and saves the result before resolving; changes never interleave.
  update<T>(change: (state: State) => T): Promise<T>;
}

const empty = (): State => ({ browsers: {}, tokens: {} });
// Drops tokens past their expiry, and rotated refresh tokens once nothing can replay them usefully.
const prune = (state: State, now: number) => {
  for (const [hash, token] of Object.entries(state.tokens)) if (token.expiresAt <= now) delete state.tokens[hash];
};

export async function fileStore(dataDir: string): Promise<Store> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'state.json');
  let state: State = await readFile(file, 'utf8')
    .then(text => JSON.parse(text) as State)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return empty();
      throw error;
    });
  let queue = Promise.resolve();
  return {
    read: () => state,
    update(change) {
      const run = queue.then(async () => {
        const next = structuredClone(state);
        const result = change(next);
        prune(next, Date.now());
        await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
        await rename(`${file}.tmp`, file);
        state = next;
        return result;
      });
      queue = run.then(
        () => {},
        () => {},
      );
      return run;
    },
  };
}

// For tests: the same contract, in memory.
export function memoryStore(initial: State = empty()): Store {
  let state = initial;
  let queue = Promise.resolve();
  return {
    read: () => state,
    update(change) {
      const run = queue.then(() => {
        const next = structuredClone(state);
        const result = change(next);
        prune(next, Date.now());
        state = next;
        return result;
      });
      queue = run.then(
        () => {},
        () => {},
      );
      return run;
    },
  };
}
