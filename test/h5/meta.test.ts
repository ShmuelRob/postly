/**
 * Guards the H5 human-owned tests against being changed or dropped. Every H5 file except
 * `pending.ts` and `subject.ts` is pinned by SHA-256 in `pins.json`, which also pins this file, so
 * any edit fails here until the human updates the pin (CODEOWNERS makes the human review it). It
 * also fails when the db or e2e project stops collecting the files, or when a package is `review` or
 * `done` in docs/implementation-plan.md while its H5 switch is still pending.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';
import { H5_PACKAGES, H5_PENDING, type H5Package } from './pending.js';

const PINS_FILE = 'test/h5/pins.json';
/** Line endings are normalized so a Windows checkout hashes the same as CI. */
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).digest('hex');

describe('H5 meta', () => {
  const pins = JSON.parse(readFileSync(PINS_FILE, 'utf8')) as Record<string, string>;

  it('pins every H5 file, this guard included', () => {
    expect(Object.keys(pins).sort()).toEqual(
      [
        'test/e2e/h5-approval-publishing.e2e.test.ts',
        'test/h5/approval.h5.test.ts',
        'test/h5/db.ts',
        'test/h5/fixtures.ts',
        'test/h5/meta.test.ts',
        'test/h5/publishing.h5.test.ts',
        'test/h5/world.ts',
        'src/contracts/approval.ts',
      ].sort(),
    );
  });

  it('no pinned H5 file has changed', () => {
    const changed = Object.entries(pins)
      .filter(([path, hash]) => sha256(path) !== hash)
      .map(([path]) => path);
    expect(changed, 'changing an H5 file needs the human (gate H5): update test/h5/pins.json in a PR they review').toEqual([]);
  });

  it('the db and e2e projects still collect the H5 files', () => {
    const projects = (config.test?.projects ?? []) as { test: { name: string; include: string[] } }[];
    const include = (name: string) => projects.find((p) => p.test.name === name)?.test.include ?? [];
    expect(include('db')).toContain('test/h5/**/*.h5.test.ts');
    expect(include('e2e')).toContain('test/e2e/**/*.e2e.test.ts');
  });

  it('a package in review or done has flipped its H5 switch', () => {
    const plan = readFileSync('docs/implementation-plan.md', 'utf8');
    for (const pkg of Object.keys(H5_PENDING) as H5Package[]) {
      const id = H5_PACKAGES[pkg];
      const row = plan.split(/\r?\n/).find((line) => line.startsWith(`| ${id} |`));
      expect(row, `${id} row in implementation-plan.md`).toBeDefined();
      const status = row?.split('|').at(-2)?.trim();
      if (status === 'review' || status === 'done') expect(H5_PENDING[pkg], `${id} is ${status}`).toBe(false);
    }
  });
});
