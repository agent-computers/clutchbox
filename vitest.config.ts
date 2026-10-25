import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
// Tests sit beside their source.
export default defineConfig({
  // Next provides `server-only`; outside it, tests import server modules through this empty stand-in.
  resolve: { alias: { 'server-only': fileURLToPath(new URL('./tests/empty-server-only.ts', import.meta.url)) } },
  // Long enough for a real Chromium to start on a CI runner.
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/{src,lib}/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
