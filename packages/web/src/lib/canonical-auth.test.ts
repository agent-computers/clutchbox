import { describe, expect, it } from 'vitest';
import { canonicalAuthUrl } from './canonical-auth';

describe('canonicalAuthUrl', () => {
  it('keeps browser auth on the canonical origin after a hostname migration, with signed queries intact', () => {
    const canonical = 'https://www.example.test';
    const legacy = 'https://legacy.example.test';
    const signedQuery =
      '?client_id=fixture&state=a%2Bb&resource=https%3A%2F%2Fwww.example.test%2Fapi%2Fmcp&sig=synthetic';
    for (const path of ['/', '/consent', '/sign-in', '/app', '/api/auth/oauth2/authorize']) {
      expect(canonicalAuthUrl(`${legacy}${path}${signedQuery}`, 'production', canonical)?.href).toBe(
        `${canonical}${path}${signedQuery}`,
      );
      expect(canonicalAuthUrl(`${canonical}${path}`, 'production', canonical)).toBeNull();
      expect(canonicalAuthUrl(`${legacy}${path}`, 'preview', canonical)).toBeNull();
    }
  });
});
