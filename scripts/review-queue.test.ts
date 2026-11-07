import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDir, legacyItems, parseItem, renderTable } from './review-queue.js';

const good = `---
added: 2026-11-07
pr: 143
gates: [H4, H8]
status: open
---

# Workflow lanes

What to review, in English.

## עברית

מה לבדוק ולמה.
`;

describe('parseItem', () => {
  it('reads a valid item', () => {
    const r = parseItem('pr-143.md', good);
    expect(r.errors).toEqual([]);
    expect(r.item).toEqual({
      source: 'dir',
      id: 'pr-143',
      pr: 143,
      added: '2026-11-07',
      gates: ['H4', 'H8'],
      status: 'open',
      title: 'Workflow lanes',
      file: 'docs/review-queue/pr-143.md',
    });
  });

  it('accepts the statuses of the old table', () => {
    for (const status of ['ok', 'waits', 'finding', 'finding (WP-24)', 'decided', 'decided (T3)', 'open (H4 part approved)']) {
      expect(parseItem('pr-143.md', good.replace('status: open', `status: ${status}`)).errors, status).toEqual([]);
    }
  });

  it('accepts CRLF line endings', () => {
    expect(parseItem('pr-143.md', good.replaceAll('\n', '\r\n')).errors).toEqual([]);
  });

  const broken: [string, string, RegExp][] = [
    ['no front matter', good.replace(/^---[\s\S]*?---\n/, ''), /front matter/],
    ['bad date', good.replace('2026-11-07', '7.11.2026'), /added/],
    ['pr does not match the file name', good.replace('pr: 143', 'pr: 144'), /pr/],
    ['unknown gate', good.replace('[H4, H8]', '[H4, H9]'), /gate/],
    ['no gates', good.replace('[H4, H8]', '[]'), /gate/],
    ['unknown status', good.replace('status: open', 'status: done'), /status/],
    ['missing key', good.replace('status: open\n', ''), /status/],
    ['no title', good.replace('# Workflow lanes\n', ''), /title/],
    ['no Hebrew section', good.replace(/## עברית[\s\S]*$/, ''), /Hebrew/],
    ['Hebrew section without Hebrew', good.replace('מה לבדוק ולמה.', 'English only.'), /Hebrew/],
    ['no English text', good.replace('What to review, in English.\n', ''), /English/],
  ];
  for (const [name, text, error] of broken) {
    it(`refuses an item with ${name}`, () => {
      const r = parseItem('pr-143.md', text);
      expect(r.item).toBeUndefined();
      expect(r.errors.join('\n')).toMatch(error);
    });
  }
});

describe('checkDir', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const dir = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), 'rq-'));
    dirs.push(d);
    for (const [n, t] of Object.entries(files)) writeFileSync(join(d, n), t);
    return d;
  };

  it('allows only README.md, README.summary.he.md and pr-<N>.md', () => {
    const r = checkDir(dir({ 'README.md': '# R\n', 'README.summary.he.md': '# ר\n', 'pr-143.md': good, 'item-1.md': good, 'notes.txt': 'x' }));
    expect(r.items.map((i) => i.id)).toEqual(['pr-143']);
    expect(r.errors).toEqual(['item-1.md: not an item file name (pr-<N>.md)', 'notes.txt: not an item file name (pr-<N>.md)']);
  });

  it('every file in docs/review-queue/ is valid (the CI check)', () => {
    const r = checkDir(resolve('docs/review-queue'));
    expect(r.errors).toEqual([]);
  });
});

describe('legacyItems', () => {
  it('reads the old table rows', () => {
    const text = [
      '| # | Added | Package / PR | Gate | What to review | Status |',
      '| --- | --- | --- | --- | --- | --- |',
      '| 1 | 2026-11-02 | WP-01 / [#4](https://github.com/ShmuelRob/postly/pull/4) | Tenant isolation | The import rules. Check this. | finding (WP-24) |',
      '| 2 | 2026-11-03 | T2 | H4 | A pipe \\| inside. More. | open |',
      '',
      '## Decisions',
      '| T1 | not an item row | x |',
    ].join('\n');
    const items = legacyItems(text);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ source: 'table', id: '#1', pr: 4, added: '2026-11-02', gates: ['Tenant isolation'], status: 'finding (WP-24)' });
    expect(items[1]).toMatchObject({ id: '#2', pr: undefined, status: 'open', title: 'T2: A pipe | inside.' });
  });

  it('reads every numbered row of the real table', () => {
    const items = legacyItems(readFileSync('docs/human-review-queue.md', 'utf8'));
    expect(items.length).toBeGreaterThanOrEqual(75);
    expect(items.map((i) => i.id).slice(0, 3)).toEqual(['#1', '#2', '#3']);
  });
});

describe('renderTable', () => {
  it('prints one Markdown table, escaping pipes', () => {
    const { item } = parseItem('pr-143.md', good.replace('# Workflow lanes', '# A | B'));
    const out = renderTable([item!]);
    expect(out.split('\n')[0]).toBe('| Item | PR | Added | Gates | Status | Title |');
    expect(out).toContain('| pr-143 | #143 | 2026-11-07 | H4, H8 | open | A \\| B |');
  });
});

describe('review-queue.ts CLI', { timeout: 30_000 }, () => {
  const script = resolve('scripts/review-queue.ts');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', script, ...args], { encoding: 'utf8' });
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('--check passes on the repository', () => {
    const r = run('--check');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('--check fails on a broken item and names it', () => {
    const d = mkdtempSync(join(tmpdir(), 'rq-'));
    dirs.push(d);
    mkdirSync(join(d, 'q'));
    writeFileSync(join(d, 'q', 'pr-9.md'), good);
    const r = run('--check', '--dir', join(d, 'q'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('pr-9.md');
  });

  it('prints only open and waiting items by default, and every item with --all', () => {
    const open = run();
    expect(open.status).toBe(0);
    const rows = open.stdout.split('\n').filter((l) => /^\| (#|pr-)/.test(l));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((l) => /\| (open|waits)\b[^|]*\| [^|]*\|$/.test(l))).toBe(true);
    const all = JSON.parse(run('--all', '--json').stdout) as { status: string }[];
    expect(all.length).toBeGreaterThan(rows.length);
    expect(all.some((i) => i.status === 'ok')).toBe(true);
  });
});
