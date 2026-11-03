/**
 * Guards the H5 human-owned tests against being dropped. It fails when a case title listed here is
 * missing from its file, when an H5 file skips, focuses, or marks a case todo or failing by hand,
 * when an H5 unit file stops using the `h5It` switch, when the db or e2e project stops collecting the
 * files, or when a package is `review` or `done` in docs/implementation-plan.md while its H5 switch
 * is still pending. Changing this list is a change to the human-owned tests and needs the human (H5).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';
import { H5_PACKAGES, H5_PENDING, type H5Package } from './pending.js';

const FILES = {
  approval: 'test/h5/approval.h5.test.ts',
  publishing: 'test/h5/publishing.h5.test.ts',
  e2e: 'test/e2e/h5-approval-publishing.e2e.test.ts',
} as const;

const TITLES = [
  'the approver tapping approve on the current version approves the post and records the hash',
  'free text "${text}" from the approver never approves',
  'a voice note or an image from the approver never approves',
  'a change button never approves',
  'an approve tap from any other number is refused',
  "another business's approver cannot approve this business's post",
  'a button carrying a stale version hash is refused, and the current one approves',
  'a hash that belongs to no version is refused',
  'a second tap on an already approved post is refused and adds no approval',
  'a change after approval invalidates the approval and the post leaves approved',
  'a change after scheduling invalidates the approval and cancels the pending publications',
  "a business's own approver tapping a button with another business's post is refused",
  'a publication tied to the valid approval of the current version publishes exactly once per channel',
  'a publication whose approval was invalidated by a new version is refused and reaches no network',
  'a publication whose hash differs from its approval hash is refused',
  'a pending publication of a post changed after scheduling never publishes',
  'a published publication is not published again',
  '${c.name} defers publishing without changing state, and it publishes once lifted',
  "a publication pointing at another business's approval never publishes",
  'a rejected attempt goes to retry_pending and the retry publishes once',
  'after a lost response the retry finds the live post and does not create a second one',
  'H5 e2e: free text and stale buttons never publish; only the approver tapping the current version does',
  'H5 e2e: a stranger tapping approve publishes nothing, and a pause holds an approved post',
];

/** Free texts that must each stay a refused case (PRD: free text never counts as approval). */
const FREE_TEXTS = ['מאשר', 'אישור', 'ok', '👍'];
const DEFERRALS = ['global_pause', 'business_pause', 'handoff'];

const read = (path: string) => readFileSync(path, 'utf8');

describe('H5 meta', () => {
  it('every listed H5 case is still present', () => {
    const source = Object.values(FILES).map(read).join('\n');
    expect(TITLES.filter((t) => !source.includes(t))).toEqual([]);
  });

  it('the looped cases still cover every required free text and deferral', () => {
    const texts = /for \(const text of \[([^\]]*)\]\)/.exec(read(FILES.approval))?.[1] ?? '';
    for (const text of FREE_TEXTS) expect(texts).toContain(`'${text}'`);
    const publishing = read(FILES.publishing);
    for (const reason of DEFERRALS) expect(publishing).toContain(`reason: '${reason}'`);
  });

  it('no H5 case is skipped, focused, todo, or marked failing by hand', () => {
    for (const path of Object.values(FILES)) {
      expect(read(path), path).not.toMatch(/\.(skip|only|todo|skipIf|runIf|concurrent)\b/);
    }
    for (const path of [FILES.approval, FILES.publishing]) expect(read(path), path).not.toMatch(/\.fails\b/);
  });

  it('the unit H5 files run every case through the h5It switch', () => {
    for (const [pkg, path] of [['approval', FILES.approval], ['publishing', FILES.publishing]] as const) {
      const source = read(path);
      expect(source, path).toContain(`const it = h5It('${pkg}');`);
      expect(source, path).not.toMatch(/import \{[^}]*\bit\b[^}]*\} from 'vitest'/);
    }
    expect(read(FILES.e2e)).toMatch(/H5_PENDING\.approval \|\| H5_PENDING\.publishing/);
  });

  it('the db and e2e projects still collect the H5 files', () => {
    const projects = (config.test?.projects ?? []) as { test: { name: string; include: string[] } }[];
    const include = (name: string) => projects.find((p) => p.test.name === name)?.test.include ?? [];
    expect(include('db')).toContain('test/h5/**/*.h5.test.ts');
    expect(include('e2e')).toContain('test/e2e/**/*.e2e.test.ts');
  });

  it('a package in review or done has flipped its H5 switch', () => {
    const plan = read('docs/implementation-plan.md');
    for (const pkg of Object.keys(H5_PENDING) as H5Package[]) {
      const id = H5_PACKAGES[pkg];
      const row = plan.split('\n').find((line) => line.startsWith(`| ${id} |`));
      expect(row, `${id} row in implementation-plan.md`).toBeDefined();
      const status = row?.split('|').at(-2)?.trim();
      if (status === 'review' || status === 'done') expect(H5_PENDING[pkg], `${id} is ${status}`).toBe(false);
    }
  });
});
