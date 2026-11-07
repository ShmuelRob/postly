// The docs-only lane (docs/implementation-plan.md#change-size-lanes), decided by this script and never
// by judgment. CI's `changes` job uses it to skip the test jobs on a docs-only PR (docs/deployment.md#ci),
// and `npm run check:local` uses --json for the changed files and the tests that read a changed doc.
//
//   node scripts/lane.ts [--base <ref>]          exit 0 if the branch is docs-only, 1 otherwise, with the reasons
//   node scripts/lane.ts --github-output <file>  append docs_only=true|false to that file; always exit 0
//   node scripts/lane.ts --json                  print { base, files, docsOnly, blockers, readers }; exit 0
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

export interface Blocker {
  file: string;
  reason: string;
}

const DOC = /^(docs\/.+|[^/]+)\.md$/;
const CONTRACT = /^docs\/(state-machines|database-schema|contracts)\./;
const GATE = /^docs\/(human-review-queue\.|review-queue\/)/;
const DOC_PATH = /docs\/[\w./-]+?\.md/g;

/** Which changed files keep a change out of the docs-only lane, and why. An empty change is not docs-only. */
export function classify(files: readonly string[], readers: ReadonlyMap<string, readonly string[]>) {
  const blockers: Blocker[] = [];
  for (const file of files) {
    if (!DOC.test(file)) blockers.push({ file, reason: 'not docs/**/*.md or a top-level *.md' });
    else if (CONTRACT.test(file)) blockers.push({ file, reason: 'a contract doc' });
    else if (GATE.test(file)) blockers.push({ file, reason: 'a gate decision (review queue)' });
    else if (readers.has(file)) blockers.push({ file, reason: `read by ${readers.get(file)!.join(', ')}` });
  }
  return { docsOnly: files.length > 0 && blockers.length === 0, blockers };
}

/** Each `docs/**.md` path named in a test file, mapped to the test files that name it. */
export function docReaders(tests: Readonly<Record<string, string>>) {
  const readers = new Map<string, string[]>();
  for (const [file, text] of Object.entries(tests).sort(([a], [b]) => a.localeCompare(b))) {
    for (const doc of new Set(text.match(DOC_PATH) ?? [])) readers.set(doc, [...(readers.get(doc) ?? []), file]);
  }
  return readers;
}

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Files changed on this branch since it left `base`, plus uncommitted and untracked files. */
export function changedFiles(base: string) {
  return [
    ...new Set([
      ...git('diff', '--name-only', '--no-renames', `${base}...HEAD`),
      ...git('diff', '--name-only', '--no-renames', 'HEAD'),
      ...git('ls-files', '--others', '--exclude-standard'),
    ]),
  ].sort();
}

function repoReaders() {
  const tests = git('ls-files', '*.test.ts');
  return docReaders(Object.fromEntries(tests.map((f) => [f, readFileSync(f, 'utf8')])));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const base = opt('--base') ?? 'origin/dev';
  const files = changedFiles(base);
  const readers = repoReaders();
  const { docsOnly, blockers } = classify(files, readers);
  const output = opt('--github-output');
  if (args.includes('--json')) {
    console.log(JSON.stringify({ base, files, docsOnly, blockers, readers: Object.fromEntries(readers) }, null, 2));
  } else if (output) {
    appendFileSync(output, `docs_only=${docsOnly}\n`);
    console.log(`${files.length} files changed against ${base}; docs_only=${docsOnly}`);
    for (const b of blockers) console.log(`  ${b.file}: ${b.reason}`);
  } else {
    console.log(`docs-only: ${docsOnly ? 'yes' : 'no'} (${files.length} files changed against ${base})`);
    if (files.length === 0) console.log('  no changes');
    for (const b of blockers) console.log(`  ${b.file}: ${b.reason}`);
    process.exit(docsOnly ? 0 : 1);
  }
}
