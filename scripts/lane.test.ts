import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classify, docReaders, FIXTURE_TESTS, repoTests } from './lane.js';

const noReaders = new Map<string, string[]>();

describe('classify (the docs-only lane)', () => {
  it('accepts docs/**/*.md and top-level *.md', () => {
    const r = classify(['docs/agent.md', 'docs/agent.summary.he.md', 'README.md', 'docs/sub/x.md'], noReaders);
    expect(r.docsOnly).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  it('refuses code, config, workflows and non-Markdown files under docs/', () => {
    const r = classify(['docs/a.md', 'src/x.ts', '.github/workflows/ci.yml', 'docs/img.png', 'src/modules/README.md'], noReaders);
    expect(r.docsOnly).toBe(false);
    expect(r.blockers.map((b) => b.file)).toEqual(['src/x.ts', '.github/workflows/ci.yml', 'docs/img.png', 'src/modules/README.md']);
  });

  it('refuses the contract docs and their Hebrew summaries', () => {
    for (const f of [
      'docs/state-machines.md',
      'docs/state-machines.summary.he.md',
      'docs/database-schema.md',
      'docs/contracts.md',
      'docs/contracts.summary.he.md',
    ]) {
      const r = classify([f], noReaders);
      expect(r.docsOnly, f).toBe(false);
      expect(r.blockers[0]?.reason).toMatch(/contract/);
    }
  });

  it('refuses the gate decisions: the old queue table and the review-queue directory', () => {
    for (const f of ['docs/human-review-queue.md', 'docs/human-review-queue.summary.he.md', 'docs/review-queue/pr-12.md', 'docs/review-queue/README.md']) {
      const r = classify([f], noReaders);
      expect(r.docsOnly, f).toBe(false);
      expect(r.blockers[0]?.reason).toMatch(/gate/);
    }
  });

  it('refuses a doc that a test reads, naming the test', () => {
    const readers = new Map([['docs/observability.md', ['src/shared/telemetry.test.ts']]]);
    const r = classify(['docs/observability.md', 'docs/agent.md'], readers);
    expect(r.docsOnly).toBe(false);
    expect(r.blockers).toEqual([{ file: 'docs/observability.md', reason: 'read by src/shared/telemetry.test.ts' }]);
  });

  it('an empty diff is not docs-only (run everything)', () => {
    expect(classify([], noReaders).docsOnly).toBe(false);
  });
});

describe('docReaders', () => {
  it('maps each docs/*.md path named in a test file to the tests that name it', () => {
    const readers = docReaders({
      'src/a.test.ts': "readFileSync(new URL('../../docs/observability.md', import.meta.url))",
      'src/b.test.ts': "readFileSync('docs/implementation-plan.md'); readFileSync('docs/observability.md')",
      'src/c.test.ts': 'no docs here',
    });
    expect(readers.get('docs/observability.md')).toEqual(['src/a.test.ts', 'src/b.test.ts']);
    expect(readers.get('docs/implementation-plan.md')).toEqual(['src/b.test.ts']);
    expect(readers.size).toBe(2);
  });

  it('finds the docs the real test suite reads, and not the fixtures of its own tests', () => {
    // This repository's tests read these docs today; the lane must keep sending them through the tests.
    const readers = docReaders(repoTests());
    for (const doc of ['docs/observability.md', 'docs/implementation-plan.md', 'docs/database-schema.md']) {
      expect(readers.has(doc), doc).toBe(true);
    }
    // docs/agent.md is a fixture here and in check-local.test.ts; no real test reads it.
    expect(readers.has('docs/agent.md')).toBe(false);
    for (const tests of readers.values()) for (const t of FIXTURE_TESTS) expect(tests).not.toContain(t);
  });
});

describe('lane.ts on a git branch', { timeout: 30_000 }, () => {
  const script = resolve('scripts/lane.ts');
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function repo(changed: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'lane-'));
    dirs.push(dir);
    const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
    const write = (files: Record<string, string>) => {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name, '..'), { recursive: true });
        writeFileSync(join(dir, name), text);
      }
    };
    git('init', '-q', '-b', 'base');
    write({ 'docs/a.md': '# A\n', 'src/x.test.ts': "readFileSync('docs/read.md')\n", 'docs/read.md': '# R\n' });
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'feature');
    write(changed);
    git('add', '.');
    git('commit', '-qm', 'change');
    return dir;
  }
  const run = (dir: string, ...args: string[]) =>
    spawnSync(process.execPath, ['--experimental-strip-types', script, '--base', 'base', ...args], { cwd: dir, encoding: 'utf8' });

  it('passes on a docs-only branch', () => {
    const r = run(repo({ 'docs/a.md': '# A\nmore\n' }));
    expect(r.stdout).toContain('docs-only: yes');
    expect(r.status).toBe(0);
  });

  it('fails on a branch that changes a doc a test reads, and says why', () => {
    const r = run(repo({ 'docs/read.md': '# R\nmore\n' }));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('docs/read.md: read by src/x.test.ts');
  });

  it('--github-output writes docs_only and always exits 0', () => {
    const dir = repo({ 'src/y.ts': 'export {};\n' });
    const out = join(dir, 'gh-output');
    writeFileSync(out, '');
    const r = run(dir, '--github-output', out);
    expect(r.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('docs_only=false\n');
  });

  it('--json prints the changed files and the docs readers', () => {
    const r = run(repo({ 'docs/read.md': '# R\nmore\n', 'src/y.ts': 'export {};\n' }), '--json');
    const json = JSON.parse(r.stdout) as { files: string[]; docsOnly: boolean; readers: Record<string, string[]> };
    expect(json.files.sort()).toEqual(['docs/read.md', 'src/y.ts']);
    expect(json.docsOnly).toBe(false);
    expect(json.readers['docs/read.md']).toEqual(['src/x.test.ts']);
    expect(r.status).toBe(0);
  });
});
