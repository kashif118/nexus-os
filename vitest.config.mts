import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.mts'],
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    // Integration tests talk to a real database; they skip themselves when one
    // is not configured (see vitest.setup.mts).
    testTimeout: 30_000,
    hookTimeout: 30_000,

    /**
     * Cap the worker count.
     *
     * Each test file runs in its own process with its own Prisma pool, and they
     * all point at one embedded Postgres. Unbounded parallelism exhausted its
     * connection limit as the suite grew, which showed up as hook timeouts in
     * whichever files happened to start last — a failure that looks like a bug
     * in the code under test and is not.
     *
     * Six is comfortably under the default `max_connections` of 100 with each
     * pool at its default size, and still uses the machine.
     */
    poolOptions: {
      forks: { maxForks: 6, minForks: 1 },
      threads: { maxThreads: 6, minThreads: 1 },
    },
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/kernel/**', 'src/lib/**', 'src/modules/**'],
    },
  },
})
