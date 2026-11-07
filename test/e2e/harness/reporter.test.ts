import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestModule } from 'vitest/node';
import { describe, expect, it } from 'vitest';
import E2eReporter, { reportTestsFrom } from './reporter.js';

// agentic-development.md, "Timeouts and flaky end-to-end tests": a test that passed on its retry is
// marked flaky in the report and in the CI job summary.

function testCase(name: string, state: 'passed' | 'failed', diagnostic: { flaky: boolean; retryCount: number; duration: number }) {
  return {
    fullName: name,
    result: () => (state === 'failed' ? { state, errors: [{ message: 'boom', stack: 'boom at x' }] } : { state }),
    diagnostic: () => diagnostic,
    meta: () => ({}),
  };
}

function module(project: string, cases: ReturnType<typeof testCase>[]): TestModule {
  return {
    project: { name: project },
    moduleId: join(process.cwd(), 'test/e2e/messaging.e2e.test.ts'),
    errors: () => [],
    children: { allTests: () => cases },
  } as unknown as TestModule;
}

const modules = [
  module('e2e', [
    testCase('steady', 'passed', { flaky: false, retryCount: 0, duration: 10 }),
    testCase('debounce window closes', 'passed', { flaky: true, retryCount: 1, duration: 20 }),
    testCase('fails twice', 'failed', { flaky: false, retryCount: 1, duration: 30 }),
  ]),
  module('unit', [testCase('not e2e', 'passed', { flaky: true, retryCount: 1, duration: 1 })]),
];

describe('the e2e reporter', () => {
  it('marks a test that passed on retry as flaky, and only e2e projects count', () => {
    const tests = reportTestsFrom(modules);
    expect(tests.map((t) => [t.name, t.state, t.flaky ?? false, t.retries ?? 0])).toEqual([
      ['steady', 'passed', false, 0],
      ['debounce window closes', 'passed', true, 1],
      ['fails twice', 'failed', false, 1],
    ]);
    expect(tests[0]!.file).toBe('test/e2e/messaging.e2e.test.ts');
  });

  it('appends the run to the CI job summary when GITHUB_STEP_SUMMARY is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'summary-'));
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '# earlier step\n');
    const env = { E2E_REPORT_DIR: join(dir, 'reports'), GITHUB_STEP_SUMMARY: summary };
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      new E2eReporter().onTestRunEnd(modules);
    } finally {
      for (const key of Object.keys(env)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
    const md = readFileSync(summary, 'utf8');
    expect(md.startsWith('# earlier step\n')).toBe(true);
    expect(md).toContain('2 passed · 1 failed · 1 flaky');
    expect(md).toContain('debounce window closes (retries: 1)');
    rmSync(dir, { recursive: true, force: true });
  });
});
