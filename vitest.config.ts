import { defineConfig } from 'vitest/config';

// Suites that launch Chromium through Playwright. Each holds a browser and renders for
// minutes; run alongside everything else they starve the CPU-bound tests (boundaries,
// the example-set loader) and their own browser hooks into timeouts.
const browserTests = ['src/modules/design/render.test.ts', 'src/modules/design/styles/*.test.ts'];
// End-to-end suites that drive Chromium (the playground UI): same reason, plus the database.
const browserE2eTests = ['test/e2e/playground.e2e.test.ts'];

export default defineConfig({
  test: {
    // The e2e reporter writes reports/e2e/index.html whenever the run includes e2e tests.
    reporters: ['default', './test/e2e/harness/reporter.ts'],
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'scripts/**/*.test.ts', 'playground/**/*.test.ts'],
          exclude: ['test/**/*.e2e.test.ts', 'test/fixtures/**', '**/*.db.test.ts', 'test/h5/**/*.h5.test.ts', ...browserTests],
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
          // Also the H5 human-owned approval and publishing tests.
          include: ['src/**/*.db.test.ts', 'playground/**/*.db.test.ts', 'test/h5/**/*.h5.test.ts'],
          globalSetup: ['./test/db/global-setup.ts'],
          hookTimeout: 120_000,
          // The H5 worlds run one at a time (a database lock, test/h5/subject.ts), so an H5 case
          // may wait for another file's case under a full run.
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.e2e.test.ts'],
          exclude: browserE2eTests,
          // The same migrated Postgres as the db project, for flows that store what the app did.
          globalSetup: ['./test/db/global-setup.ts'],
          hookTimeout: 120_000,
          // Several e2e files use the H5 world, which runs one at a time (a database lock,
          // test/h5/subject.ts), so a case may wait for another file's case under a full run.
          testTimeout: 30_000,
        },
      },
      {
        test: {
          // The e2e suites that drive a browser, last: after the design project (its own group, since maxWorkers differs).
          name: 'e2e-browser',
          include: browserE2eTests,
          sequence: { groupOrder: 2 },
          maxWorkers: 1,
          globalSetup: ['./test/db/global-setup.ts'],
          hookTimeout: 120_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
