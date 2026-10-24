import { defineConfig } from 'vitest/config';
// Tests sit beside their source.
export default defineConfig({
  // Long enough for a real Chromium to start on a CI runner.
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
