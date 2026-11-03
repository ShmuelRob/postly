import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/check-links.ts');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function runOn(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'links-'));
  dirs.push(dir);
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir });
  git('init', '-q');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  git('add', '.');
  return spawnSync(process.execPath, ['--experimental-strip-types', script], { cwd: dir, encoding: 'utf8' });
}

describe('check-links', { timeout: 30_000 }, () => {
  it('passes on valid file and anchor links', () => {
    const r = runOn({ 'a.md': '# Top\n[b](b.md#sec) [self](#top)\n', 'b.md': '## Sec\n' });
    expect(r.status).toBe(0);
  });
  it('fails on a missing file', () => {
    const r = runOn({ 'a.md': '[x](nope.md)\n' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('missing file');
  });
  it('fails on a missing anchor', () => {
    const r = runOn({ 'a.md': '[x](b.md#gone)\n', 'b.md': '# Here\n' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('missing anchor');
  });
});
