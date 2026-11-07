// `npm run check:local`: the light gate a session runs before pushing (docs/implementation-plan.md#rules-every-session-follows).
// Typecheck, conflict markers, links, boundaries and the review-queue files, then the unit tests related to
// the files changed against origin/dev (and the tests that read a changed doc). No Docker, no browser:
// CI runs the full `npm run check` and is the gate.
//
//   node scripts/check-local.ts [--base <ref>]
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface Step {
  name: string;
  cmd: string;
  args: string[];
  /** Skipped with a warning when the command is not installed. */
  optional?: boolean;
}

interface Lane {
  files: string[];
  readers: Record<string, string[]>;
}

// Modules only: given a non-module file such as package.json, `vitest related` runs the whole project.
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;

/** The steps for a set of changed files. `exists` filters out deleted files. */
export function localSteps(lane: Lane, exists: (file: string) => boolean): Step[] {
  const steps: Step[] = ['typecheck', 'lint:conflicts', 'lint:links', 'lint:boundaries', 'lint:review-queue'].map((name) => ({
    name,
    cmd: 'npm',
    args: ['run', '--silent', name],
  }));
  const code = lane.files.filter((f) => CODE.test(f) && exists(f));
  const readers = lane.files.flatMap((f) => lane.readers[f] ?? []).filter(exists);
  const targets = [...new Set([...code, ...readers])];
  if (targets.length > 0) {
    steps.push({ name: 'unit (related)', cmd: 'npx', args: ['vitest', 'related', '--run', '--project', 'unit', '--passWithNoTests', ...targets] });
  }
  if (lane.files.some((f) => f.startsWith('infra/'))) {
    steps.push({ name: 'terraform fmt', cmd: 'terraform', args: ['fmt', '-check', '-recursive', 'infra'], optional: true });
  }
  return steps;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--base');
  const base = i === -1 ? 'origin/dev' : args[i + 1]!;
  const lane = JSON.parse(
    execFileSync(process.execPath, ['scripts/lane.ts', '--json', '--base', base], { encoding: 'utf8' }),
  ) as Lane;
  console.log(`check:local: ${lane.files.length} files changed against ${base}`);
  const failed: string[] = [];
  for (const step of localSteps(lane, existsSync)) {
    console.log(`\n> ${step.name}`);
    // npm and npx are .cmd files on Windows, which need a shell; the args are repo paths and fixed flags.
    const r =
      process.platform === 'win32'
        ? spawnSync([step.cmd, ...step.args].join(' '), { stdio: 'inherit', shell: true })
        : spawnSync(step.cmd, step.args, { stdio: 'inherit' });
    const missing = r.error !== undefined || (process.platform === 'win32' && r.status === 9009);
    if (step.optional && missing) {
      console.warn(`${step.name}: ${step.cmd} is not installed; run it before pushing, or CI's Infra check will fail.`);
    } else if (r.status !== 0) failed.push(step.name);
  }
  if (failed.length > 0) {
    console.error(`\ncheck:local failed: ${failed.join(', ')}`);
    process.exit(1);
  }
  console.log('\ncheck:local passed. CI runs npm run check and is the gate.');
}
