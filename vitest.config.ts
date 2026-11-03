import { defineConfig } from 'vitest/config';

// Suites that launch Chromium through Playwright. Each holds a browser and renders for
// minutes; run alongside everything else they starve the CPU-bound tests (boundaries,
// the example-set loader) and their own browser hooks into timeouts.
const browserTests = ['src/modules/design/render.test.ts', 'src/modules/design/styles/*.test.ts'];

export default defineConfig({
  test: {
    // The e2e reporter writes reports/e2e/index.html whenever the run includes e2e tests.
    reporters: ['default', './test/e2e/harness/reporter.ts'],
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['test/**/*.e2e.test.ts', 'test/fixtures/**', '**/*.db.test.ts', ...browserTests],
        },
      },
      {
        test: {
          // After the other projects finish, with at most two browsers at once.
          name: 'design',
          include: browserTests,
          sequence: { groupOrder: 1 },
          maxWorkers: 2,
        },
      },
      {
        test: {
          // Against a real Postgres, started once per run by test/db/global-setup.ts.
          name: 'db',
          include: ['src/**/*.db.test.ts'],
          globalSetup: ['./test/db/global-setup.ts'],
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.e2e.test.ts'],
        },
      },
    ],
  },
});
