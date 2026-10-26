import { describe, expect, it } from 'vitest';
import { allowedMutationOrigin, extensionOrigins } from './origins';

const web = 'https://www.clutchbox.dev';
const ext = `chrome-extension://${'a'.repeat(32)}`;
const other = `chrome-extension://${'b'.repeat(32)}`;
describe('allowedMutationOrigin', () => {
  it('accepts the web origin on every route', () => {
    expect(allowedMutationOrigin(web, '/api/v1/computer', web, undefined)).toBe(true);
    expect(allowedMutationOrigin(web, '/api/v1/captures', web, ext)).toBe(true);
  });
  it('accepts pinned extension origins only for captures and sync settings', () => {
    expect(allowedMutationOrigin(ext, '/api/v1/captures', web, ` ${other} , ${ext}/ `)).toBe(true);
    expect(allowedMutationOrigin(ext, '/api/v1/sync', web, ext)).toBe(true);
    expect(allowedMutationOrigin(ext, '/api/v1/sync/adopt', web, ext)).toBe(true);
    expect(allowedMutationOrigin(ext, '/api/v1/sync/disconnect', web, ext)).toBe(false);
    expect(allowedMutationOrigin(ext, '/api/v1/computer', web, ext)).toBe(false);
    expect(allowedMutationOrigin(ext, '/api/v1/captures/x', web, ext)).toBe(false);
    expect(allowedMutationOrigin(ext, '/api/v1/mcp/revoke', web, ext)).toBe(false);
  });
  it('rejects unpinned, missing, and look-alike origins', () => {
    expect(allowedMutationOrigin(other, '/api/v1/captures', web, ext)).toBe(false);
    expect(allowedMutationOrigin(ext, '/api/v1/captures', web, undefined)).toBe(false);
    expect(allowedMutationOrigin(undefined, '/api/v1/captures', web, ext)).toBe(false);
    expect(allowedMutationOrigin('', '/api/v1/captures', web, ext)).toBe(false);
    expect(allowedMutationOrigin('null', '/api/v1/captures', web, 'null')).toBe(false);
    expect(allowedMutationOrigin('https://evil.example', '/api/v1/captures', web, '*')).toBe(false);
    expect(allowedMutationOrigin(`${web}.evil.example`, '/api/v1/computer', web, ext)).toBe(false);
  });
  it('keeps only well-formed extension origins', () => {
    expect(extensionOrigins(`${ext.toUpperCase()},,*,chrome-extension://short,https://x.example`)).toEqual([ext]);
  });
});
