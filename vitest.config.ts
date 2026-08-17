import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Integration tests boot an in-memory MongoDB; the first run may download the
    // binary, so keep the timeout generous.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Each test file gets its own in-memory Mongo instance; running files in
    // parallel would multiply RAM use for no real speedup at this suite size.
    fileParallelism: false,
    globals: false,
  },
});
