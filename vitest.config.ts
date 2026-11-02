import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The e2e reporter writes reports/e2e/index.html whenever the run includes e2e tests.
    reporters: ['default', './test/e2e/harness/reporter.ts'],
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['test/**/*.e2e.test.ts', 'test/fixtures/**'],
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
