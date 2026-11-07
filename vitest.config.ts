import { defineConfig } from 'vitest/config';

// Suites that launch Chromium through Playwright. Each holds a browser and renders for
// minutes; run alongside everything else they starve the CPU-bound tests (boundaries,
// the example-set loader) and their own browser hooks into timeouts.
const browserTests = ['src/modules/design/render.test.ts', 'src/modules/design/styles/*.test.ts'];
// End-to-end suites that drive Chromium (the playground UI): same reason, plus the database.
const browserE2eTests = ['test/e2e/playground.e2e.test.ts', 'test/e2e/console.e2e.test.ts'];

/**
 * Every project's default timeouts, in milliseconds (agentic-development.md, "Timeouts and flaky end-to-end
 * tests"). The same locally and in CI: nothing here reads the environment. A suite known to be slower may
 * give itself a larger budget in its own file, the same everywhere.
 */
export const TIMEOUTS = {
  unit: { testTimeout: 5_000, hookTimeout: 10_000 },
  design: { testTimeout: 5_000, hookTimeout: 10_000 },
  // The H5 worlds run one at a time (a database lock, test/h5/subject.ts), so an H5 case may wait for
  // another file's case under a full run.
  db: { testTimeout: 20_000, hookTimeout: 120_000 },
  // Several e2e files use the H5 world, which runs one at a time (a database lock, test/db/shared-lock.ts).
  // Each of their tests takes the lock in a beforeEach hook (the setup file), so the wait behind the other
  // files' worlds counts against the hook, not the test: the hook may wait for the queue, and a test keeps
  // its own timeout.
  e2e: { testTimeout: 30_000, hookTimeout: 600_000 },
  'e2e-browser': { testTimeout: 30_000, hookTimeout: 120_000 },
} as const;

/** The end-to-end projects: the only ones retried in CI, and the ones the e2e reporter reads. */
export const E2E_PROJECTS: ReadonlySet<string> = new Set(['e2e', 'e2e-browser']);

/**
 * One retry in CI for the end-to-end projects, none locally. A test that fails twice still fails the run;
 * one that passed on its retry is marked flaky in the report and the CI job summary
 * (test/e2e/harness/reporter.ts). No assertion changes.
 */
export function e2eRetry(env: Record<string, string | undefined>): number {
  return env.CI ? 1 : 0;
}

export default defineConfig({
  test: {
    // The e2e reporter writes reports/e2e/index.html whenever the run includes e2e tests.
    reporters: ['default', './test/e2e/harness/reporter.ts'],
    projects: [
      {
        test: {
          name: 'unit',
          ...TIMEOUTS.unit,
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
          ...TIMEOUTS.design,
        },
      },
      {
        test: {
          // Against a real Postgres, started once per run by test/db/global-setup.ts.
          name: 'db',
          // Also the H5 human-owned approval and publishing tests.
          include: ['src/**/*.db.test.ts', 'playground/**/*.db.test.ts', 'test/h5/**/*.h5.test.ts'],
          globalSetup: ['./test/db/global-setup.ts'],
          ...TIMEOUTS.db,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.e2e.test.ts'],
          exclude: browserE2eTests,
          // The same migrated Postgres as the db project, for flows that store what the app did.
          globalSetup: ['./test/db/global-setup.ts'],
          // The H5 lock hook (see TIMEOUTS.e2e).
          setupFiles: ['./test/e2e/harness/shared-lock-hook.ts'],
          ...TIMEOUTS.e2e,
          retry: e2eRetry(process.env),
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
          ...TIMEOUTS['e2e-browser'],
          retry: e2eRetry(process.env),
        },
      },
    ],
  },
});
