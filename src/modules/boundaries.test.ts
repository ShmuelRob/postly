import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const depcruiseBin = `${repoRoot}node_modules/dependency-cruiser/bin/dependency-cruiser.mjs`;
const config = `${repoRoot}.dependency-cruiser.mjs`;

// The modules listed in technical-design.md, one folder each.
const modules = [
  'messaging',
  'workflow',
  'model-layer',
  'content',
  'design',
  'publishing',
  'business-data',
  'billing',
  'console',
];

type Violation = { from: string; to: string; rule: { name: string } };
type CruiseResult = { summary: { violations: Violation[]; totalCruised: number } };

function cruise(cwd: string): CruiseResult {
  const run = spawnSync(
    process.execPath,
    [depcruiseBin, 'src', '--config', config, '--output-type', 'json'],
    { cwd, encoding: 'utf8' },
  );
  if (!run.stdout) throw new Error(`dependency-cruiser produced no output: ${run.stderr}`);
  return JSON.parse(run.stdout) as CruiseResult;
}

describe('module boundaries', () => {
  it('flags every seeded violation and nothing else', () => {
    const result = cruise(`${repoRoot}test/fixtures/boundaries`);
    const found = result.summary.violations
      .map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`)
      .sort();

    expect(found).toEqual(
      [
        'db-driver-outside-db: src/modules/content/raw-db.ts -> pg',
        'db-internals: src/modules/content/db-client.ts -> src/db/client.ts',
        'module-internals: src/modules/content/leaks-internal.ts -> src/modules/messaging/internal/dedupe.ts',
        'module-internals: src/modules/content/type-only.ts -> src/modules/messaging/internal/types.ts',
        'module-internals: src/shared/leak.ts -> src/modules/messaging/internal/dedupe.ts',
        'vendor-outside-adapter: src/modules/content/calls-vendor.ts -> twilio',
        'vendor-outside-adapter: src/modules/publishing/adapters/wrong-vendor.ts -> twilio',
      ].sort(),
    );
  });

  it('passes on the real source tree', () => {
    const result = cruise(repoRoot);
    expect(result.summary.violations).toEqual([]);
    expect(result.summary.totalCruised).toBeGreaterThan(modules.length);
  });

  it.each(modules)('module %s has a public index.ts', (name) => {
    expect(existsSync(`${repoRoot}src/modules/${name}/index.ts`)).toBe(true);
  });
});
