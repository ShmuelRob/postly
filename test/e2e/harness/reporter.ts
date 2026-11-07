import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Reporter, TestModule } from 'vitest/node';
import './record.js';
import { execFileSync } from 'node:child_process';
import { E2E_PROJECTS } from '../../../vitest.config.js';
import { renderJobSummary, writeRunReport, type ReportRun, type ReportTest } from './report.js';

/** The report's tests from a run's modules: only the e2e projects, each marked flaky when it passed on a retry. */
export function reportTestsFrom(testModules: ReadonlyArray<TestModule>): ReportTest[] {
  const tests: ReportTest[] = [];
  for (const module of testModules) {
    if (!E2E_PROJECTS.has(module.project.name)) continue;
    const file = relative(process.cwd(), module.moduleId).replaceAll('\\', '/');
    const moduleErrors = module.errors().map((e) => e.stack ?? e.message);
    if (moduleErrors.length) tests.push({ name: '(test file failed to run)', file, state: 'failed', errors: moduleErrors });
    for (const testCase of module.children.allTests()) {
      const result = testCase.result();
      const errors = result.state === 'failed' ? result.errors.map((e) => e.stack ?? e.message) : [];
      const test: ReportTest = { name: testCase.fullName, file, state: result.state, errors };
      const diagnostic = testCase.diagnostic();
      if (diagnostic?.duration !== undefined) test.durationMs = diagnostic.duration;
      if (diagnostic?.retryCount) test.retries = diagnostic.retryCount;
      if (diagnostic?.flaky) test.flaky = true;
      const record = testCase.meta().e2e;
      if (record) test.record = record;
      tests.push(test);
    }
  }
  return tests;
}

/**
 * Writes the static HTML report for every run that includes e2e tests. Output root: $E2E_REPORT_DIR or
 * reports/e2e (one folder per run, plus latest/ and a runs index). In CI it also appends the counts and the
 * flaky and failed tests to the job summary ($GITHUB_STEP_SUMMARY).
 */
export default class E2eReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const tests = reportTestsFrom(testModules);
    if (!tests.length) return;
    const root = process.env.E2E_REPORT_DIR ?? 'reports/e2e';
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-');
    const run: ReportRun = { title: 'Postly end-to-end report', generatedAt: new Date().toISOString(), tests };
    const path = writeRunReport(root, run, stamp, shortSha());
    console.log(`\nE2E report: ${path}`);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) appendFileSync(summary, renderJobSummary(run));
  }
}

function shortSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'nogit';
  }
}
