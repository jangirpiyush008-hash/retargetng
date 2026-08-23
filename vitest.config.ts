import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    setupFiles: ['./scripts/vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@aap/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@aap/db/test-utils': path.resolve(__dirname, 'packages/db/src/test-utils.ts'),
      '@aap/db/seed': path.resolve(__dirname, 'packages/db/src/seed/index.ts'),
      '@aap/db': path.resolve(__dirname, 'packages/db/src/index.ts'),
    },
  },
});
