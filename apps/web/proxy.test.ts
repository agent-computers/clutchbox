import { productMatcher } from '@agent-computers/web/proxy';
import { expect, it } from 'vitest';
import { config } from './proxy';

// Next.js reads the matcher only as the literal in proxy.ts, so it can drift from the product's: a page it misses
// skips the canonical-origin redirect, the moved pages, or the routing of /.
it("covers every path of the product's matcher", () => {
  expect(config.matcher).toEqual(expect.arrayContaining(productMatcher));
});
