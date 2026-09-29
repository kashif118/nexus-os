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
    // Seeds the authorization catalogue once, before any suite. See the file
    // for why that is not left to each suite's beforeAll.
    globalSetup: ['./vitest.global-setup.mts'],
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
     *
     * (Top-level `maxWorkers`, not `poolOptions` — Vitest 4 removed the latter,
     * and it was being ignored silently.)
     */
    maxWorkers: 6,
    minWorkers: 1,
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/kernel/**', 'src/lib/**', 'src/modules/**'],
      /*
       * React components and Server Actions are excluded, not because they do
       * not matter, but because Vitest does not instrument the Next.js server
       * that runs them. They are covered by the 43 Playwright journeys, and
       * counting them here as uncovered would make the figure say less, not
       * more. Everything that decides something — services, repositories,
       * money, authorization, the workflow engine — is in scope.
       */
      exclude: ['**/components/**', '**/*.tsx', '**/__tests__/**', '**/*.d.ts'],
    },
  },
})
