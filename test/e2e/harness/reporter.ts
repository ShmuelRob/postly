import { relative } from 'node:path';
import type { Reporter, TestModule } from 'vitest/node';
import './record.js';
import { execFileSync } from 'node:child_process';
import { writeRunReport, type ReportTest } from './report.js';

const E2E_PROJECT = 'e2e';

/** Writes the static HTML report for every run that includes e2e tests. Output root: $E2E_REPORT_DIR or reports/e2e (one folder per run, plus latest/ and a runs index). */
export default class E2eReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const tests: ReportTest[] = [];
    for (const module of testModules) {
      if (module.project.name !== E2E_PROJECT) continue;
      const file = relative(process.cwd(), module.moduleId).replaceAll('\\', '/');
      const moduleErrors = module.errors().map((e) => e.stack ?? e.message);
      if (moduleErrors.length) tests.push({ name: '(test file failed to run)', file, state: 'failed', errors: moduleErrors });
      for (const testCase of module.children.allTests()) {
        const result = testCase.result();
        const errors = result.state === 'failed' ? result.errors.map((e) => e.stack ?? e.message) : [];
        const test: ReportTest = { name: testCase.fullName, file, state: result.state, errors };
        const duration = testCase.diagnostic()?.duration;
        if (duration !== undefined) test.durationMs = duration;
        const record = testCase.meta().e2e;
        if (record) test.record = record;
        tests.push(test);
      }
    }
    if (!tests.length) return;
    const root = process.env.E2E_REPORT_DIR ?? 'reports/e2e';
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-');
    const path = writeRunReport(root, { title: 'Postly end-to-end report', generatedAt: new Date().toISOString(), tests }, stamp, shortSha());
    console.log(`\nE2E report: ${path}`);
  }
}

function shortSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'nogit';
  }
}
