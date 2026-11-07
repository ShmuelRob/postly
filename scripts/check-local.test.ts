import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { localSteps } from './check-local.js';

const all = () => true;
const names = (steps: ReturnType<typeof localSteps>) => steps.map((s) => s.name);

describe('check:local steps', () => {
  it('always runs the static checks, never Docker or a browser project', () => {
    const steps = localSteps({ files: [], readers: {} }, all);
    expect(names(steps)).toEqual(['typecheck', 'lint:conflicts', 'lint:links', 'lint:boundaries', 'lint:review-queue']);
    for (const s of steps) expect(s.args.join(' ')).not.toMatch(/--project (db|design|e2e)|docker/);
  });

  it('runs the unit tests related to the changed code files that still exist', () => {
    const exists = (f: string) => f !== 'src/gone.ts';
    const steps = localSteps({ files: ['src/a.ts', 'src/a.test.ts', 'src/gone.ts', 'docs/agent.md', 'infra/x.png'], readers: {} }, exists);
    const unit = steps.find((s) => s.name === 'unit (related)');
    expect(unit?.args).toEqual(['vitest', 'related', '--run', '--project', 'unit', '--passWithNoTests', 'src/a.ts', 'src/a.test.ts']);
  });

  it('adds the tests that read a changed doc', () => {
    const steps = localSteps(
      { files: ['docs/observability.md'], readers: { 'docs/observability.md': ['src/shared/telemetry.test.ts', 'src/db/x.db.test.ts'] } },
      all,
    );
    const unit = steps.find((s) => s.name === 'unit (related)');
    // A db test is filtered out by --project unit; it runs in CI.
    expect(unit?.args.slice(-2)).toEqual(['src/shared/telemetry.test.ts', 'src/db/x.db.test.ts']);
  });

  it('skips the unit step when no code changed', () => {
    expect(names(localSteps({ files: ['docs/agent.md'], readers: {} }, all))).not.toContain('unit (related)');
  });

  it('checks terraform fmt only when infra/ changed', () => {
    expect(names(localSteps({ files: ['src/a.ts'], readers: {} }, all))).not.toContain('terraform fmt');
    const tf = localSteps({ files: ['infra/modules/x/main.tf'], readers: {} }, all).find((s) => s.name === 'terraform fmt');
    expect(tf).toMatchObject({ cmd: 'terraform', args: ['fmt', '-check', '-recursive', 'infra'], optional: true });
  });

  it('package.json wires the scripts, and npm run check also checks the review queue', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['check:local']).toBe('node scripts/check-local.ts');
    expect(pkg.scripts['lint:review-queue']).toBe('node scripts/review-queue.ts --check');
    expect(pkg.scripts['review-queue']).toBe('node scripts/review-queue.ts');
    expect(pkg.scripts['lane:docs-only']).toBe('node scripts/lane.ts');
    expect(pkg.scripts['fmt:infra']).toBe('terraform fmt -recursive infra');
    expect(pkg.scripts.check).toContain('npm run lint:review-queue');
  });
});
