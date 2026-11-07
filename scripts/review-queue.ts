// The human-review queue (docs/review-queue/README.md): one file per PR in docs/review-queue/, plus the
// numbered rows of the old table in docs/human-review-queue.md, which no longer grows.
//
//   node scripts/review-queue.ts            the open items (open, waits) from both places as one Markdown table
//   node scripts/review-queue.ts --all      every item, whatever its status
//   node scripts/review-queue.ts --json     the same items as JSON, for the work board
//   node scripts/review-queue.ts --check    validate every file in docs/review-queue/; exit 1 on an error
//   --dir <path>, --table <path>            read another directory or table (tests)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Item {
  source: 'dir' | 'table';
  /** `pr-<N>` for a file, `#<n>` for a row of the old table. */
  id: string;
  pr: number | undefined;
  added: string;
  gates: string[];
  status: string;
  title: string;
  file: string;
}

const ITEM_FILE = /^pr-([1-9]\d*)\.md$/;
const ALLOWED = new Set(['README.md', 'README.summary.he.md']);
const GATE = /^(H[1-8]|e2e|ci)$/;
const STATUS = /^(open|ok|waits|finding|decided)( \(.+\))?$/;
const HEBREW = /[֐-׿]/;
const KEYS = ['added', 'pr', 'gates', 'status'] as const;

/** Parse and validate one `pr-<N>.md` file. */
export function parseItem(name: string, raw: string): { item?: Item; errors: string[] } {
  const errors: string[] = [];
  const text = raw.replaceAll('\r\n', '\n');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!fm) return { errors: [`${name}: no front matter (--- added, pr, gates, status ---)`] };
  const meta: Record<string, string> = {};
  for (const line of fm[1]!.split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (m) meta[m[1]!] = m[2]!.trim();
    else if (line.trim()) errors.push(`${name}: front matter line is not "key: value": ${line}`);
  }
  for (const key of KEYS) if (meta[key] === undefined) errors.push(`${name}: front matter has no ${key}`);
  for (const key of Object.keys(meta)) {
    if (!(KEYS as readonly string[]).includes(key)) errors.push(`${name}: unknown front matter key ${key}`);
  }

  const added = meta.added ?? '';
  if (meta.added !== undefined && !(/^\d{4}-\d{2}-\d{2}$/.test(added) && !Number.isNaN(Date.parse(added)))) {
    errors.push(`${name}: added must be a YYYY-MM-DD date, got ${added}`);
  }
  const fileNumber = ITEM_FILE.exec(name)?.[1];
  const pr = Number(meta.pr);
  if (meta.pr !== undefined && String(pr) !== fileNumber) errors.push(`${name}: pr ${meta.pr} does not match the file name`);
  const gatesRaw = /^\[(.*)\]$/.exec(meta.gates ?? '');
  const gates = gatesRaw ? gatesRaw[1]!.split(',').map((g) => g.trim()).filter(Boolean) : [];
  if (meta.gates !== undefined) {
    if (!gatesRaw) errors.push(`${name}: gates must be a list like [H4, H8]`);
    else if (gates.length === 0) errors.push(`${name}: gates lists no gate`);
    for (const g of gates) if (!GATE.test(g)) errors.push(`${name}: unknown gate ${g} (H1 to H8, e2e, ci)`);
  }
  const status = meta.status ?? '';
  if (meta.status !== undefined && !STATUS.test(status)) {
    errors.push(`${name}: unknown status ${status} (open, ok, waits, finding, decided, each with an optional (note))`);
  }

  const body = text.slice(fm[0].length);
  const title = /^# (.+)$/m.exec(body)?.[1]?.trim();
  if (!title) errors.push(`${name}: no "# " title`);
  const hebrewAt = body.search(/^## עברית\s*$/m);
  if (hebrewAt === -1) errors.push(`${name}: no "## עברית" Hebrew section`);
  else {
    const section = body.slice(hebrewAt).split('\n').slice(1).join('\n').split(/^## /m)[0]!;
    if (!HEBREW.test(section)) errors.push(`${name}: the Hebrew section has no Hebrew text`);
  }
  const english = (hebrewAt === -1 ? body : body.slice(0, hebrewAt)).replace(/^# .*$/m, '').trim();
  if (!english) errors.push(`${name}: no English text before the Hebrew section`);

  if (errors.length > 0) return { errors };
  return {
    item: { source: 'dir', id: `pr-${pr}`, pr, added, gates, status, title: title!, file: `docs/review-queue/${name}` },
    errors,
  };
}

/** Validate a review-queue directory: only README files and valid `pr-<N>.md` items. */
export function checkDir(dir: string) {
  const items: Item[] = [];
  const errors: string[] = [];
  if (!existsSync(dir)) return { items, errors };
  const names = readdirSync(dir).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  for (const name of names) {
    if (ALLOWED.has(name)) continue;
    if (!ITEM_FILE.test(name)) {
      errors.push(`${name}: not an item file name (pr-<N>.md)`);
      continue;
    }
    const r = parseItem(name, readFileSync(join(dir, name), 'utf8'));
    errors.push(...r.errors);
    if (r.item) items.push(r.item);
  }
  return { items, errors };
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replaceAll('\\|', '|'));
const plain = (md: string) => md.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replaceAll('`', '').replaceAll('**', '');
const firstSentence = (s: string) => {
  const t = plain(s);
  const end = t.search(/\.(\s|$)/);
  const sentence = end === -1 ? t : t.slice(0, end + 1);
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
};

/** The numbered rows of the old table (`| n | added | package / PR | gate | what | status |`). */
export function legacyItems(raw: string): Item[] {
  const items: Item[] = [];
  for (const line of raw.replaceAll('\r\n', '\n').split('\n')) {
    if (!/^\| \d+ \|/.test(line)) continue;
    const c = cells(line);
    if (c.length < 6) continue;
    const [n, added, pkg, gate, what] = c as [string, string, string, string, string];
    const prMatch = /\/pull\/(\d+)/.exec(pkg);
    items.push({
      source: 'table',
      id: `#${n}`,
      pr: prMatch ? Number(prMatch[1]) : undefined,
      added,
      gates: [plain(gate)],
      status: c.at(-1)!,
      title: `${plain(pkg)}: ${firstSentence(what)}`,
      file: 'docs/human-review-queue.md',
    });
  }
  return items;
}

/** Still waiting on the human: `open` or `waits`, with or without a note (the old table has `open (H4 part approved ...)`). */
export const isOpen = (i: Item) => /^(open|waits)\b/.test(i.status);

/** One Markdown table of the items. */
export function renderTable(items: readonly Item[]) {
  const esc = (s: string) => s.replaceAll('|', '\\|');
  return [
    '| Item | PR | Added | Gates | Status | Title |',
    '| --- | --- | --- | --- | --- | --- |',
    ...items.map((i) => `| ${i.id} | ${i.pr ? `#${i.pr}` : ''} | ${i.added} | ${esc(i.gates.join(', '))} | ${esc(i.status)} | ${esc(i.title)} |`),
  ].join('\n');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const dir = opt('--dir') ?? 'docs/review-queue';
  const { items, errors } = checkDir(dir);
  if (args.includes('--check')) {
    if (errors.length > 0) {
      console.error(`Review-queue files with errors (format: docs/review-queue/README.md):\n${errors.join('\n')}`);
      process.exit(1);
    }
    console.log(`${items.length} review-queue files valid in ${dir}.`);
  } else {
    if (errors.length > 0) console.error(errors.join('\n'));
    const table = opt('--table') ?? 'docs/human-review-queue.md';
    const every = [...(existsSync(table) ? legacyItems(readFileSync(table, 'utf8')) : []), ...items];
    const shown = args.includes('--all') ? every : every.filter(isOpen);
    console.log(args.includes('--json') ? JSON.stringify(shown, null, 2) : renderTable(shown));
    if (errors.length > 0) process.exit(1);
  }
}
