import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config, { E2E_PROJECTS, e2eRetry, TIMEOUTS } from '../vitest.config.js';

// agentic-development.md, "Timeouts and flaky end-to-end tests": one timeout table, the same locally and
// in CI, and one retry in CI for the end-to-end projects only.

interface ProjectTest {
  name: string;
  testTimeout?: number;
  hookTimeout?: number;
  retry?: number;
}
const projects = (config.test!.projects as { test: ProjectTest }[]).map((p) => p.test);

describe('the timeout table', () => {
  it('has a row for every project, and every project takes its timeouts from it', () => {
    expect(Object.keys(TIMEOUTS).sort()).toEqual(projects.map((p) => p.name).sort());
    for (const p of projects) {
      const row = TIMEOUTS[p.name as keyof typeof TIMEOUTS];
      expect({ name: p.name, testTimeout: p.testTimeout, hookTimeout: p.hookTimeout }).toEqual({ name: p.name, ...row });
    }
  });

  it('does not depend on the environment, and no test file reads CI', () => {
    const source = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8');
    const table = source.slice(source.indexOf('export const TIMEOUTS'), source.indexOf('} as const'));
    expect(table).not.toMatch(/process\.env|env\./);

    const root = fileURLToPath(new URL('../', import.meta.url));
    const files = ['src', 'test', 'playground', 'scripts'].flatMap((top) => testFiles(join(root, top)));
    const readers = files.filter((f) => /process\.env\.CI\b|env\.CI\b/.test(readFileSync(f, 'utf8')) && !f.endsWith('vitest-config.test.ts'));
    expect(readers.map((f) => relative(root, f).split(sep).join('/'))).toEqual([]);
  });
});

describe('the e2e retry', () => {
  it('is one retry in CI and none locally', () => {
    expect(e2eRetry({ CI: 'true' })).toBe(1);
    expect(e2eRetry({})).toBe(0);
    expect(e2eRetry({ CI: '' })).toBe(0);
  });

  it('applies to the end-to-end projects only', () => {
    expect([...E2E_PROJECTS].sort()).toEqual(['e2e', 'e2e-browser']);
    for (const p of projects) {
      if (E2E_PROJECTS.has(p.name)) expect(p.retry, p.name).toBe(e2eRetry(process.env));
      else expect(p.retry, p.name).toBeUndefined();
    }
  });
});

function testFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'fixtures' ? [] : testFiles(path);
    return entry.name.endsWith('.test.ts') ? [path] : [];
  });
}
