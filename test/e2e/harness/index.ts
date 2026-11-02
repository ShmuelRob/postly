import { test } from 'vitest';
import { startE2eRun, type E2eRun, type StartOptions } from './app.js';
import { emptyRecord } from './record.js';

export type { AppFactory, AppUnderTest, E2eRun, MediaReader, Owner, Providers, StartOptions } from './app.js';
export type { E2eRecord, PublishingEntry, RenderedImage, TranscriptEntry } from './record.js';
export { placeholderPng } from './png.js';

export interface E2eHarness {
  /** Builds the app in-process with the given providers and starts recording for the report. */
  start(options: StartOptions): Promise<E2eRun>;
}

/**
 * `test` with an `e2e` fixture. Everything a run records lands in the test's metadata, and the e2e
 * reporter turns it into reports/e2e/index.html, whether the test passes or fails.
 */
export const e2eTest = test.extend<{ e2e: E2eHarness }>({
  e2e: async ({ task }, use) => {
    const record = emptyRecord();
    task.meta.e2e = record;
    const runs: E2eRun[] = [];
    await use({
      start: async (options) => {
        const run = await startE2eRun(record, options);
        runs.push(run);
        return run;
      },
    });
    for (const run of runs) await run.close();
  },
});
