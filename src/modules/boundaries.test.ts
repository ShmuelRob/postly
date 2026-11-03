import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cruise, type ICruiseResult, type IViolation } from 'dependency-cruiser';
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options';
import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
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

// In-process, not a spawned CLI: a cold dependency-cruiser process costs several
// seconds under a loaded full run, and spawnSync blocks the worker while it runs.
async function cruiseTree(baseDir: string): Promise<ICruiseResult> {
  const options = await extractDepcruiseOptions(config);
  const { output } = await cruise(['src'], { ...options, baseDir });
  if (typeof output === 'string') throw new Error('dependency-cruiser returned a string, expected a result object');
  return output;
}

const format = (v: IViolation) => `${v.rule.name}: ${v.from} -> ${v.to}`;

describe('module boundaries', () => {
  let fixtures: ICruiseResult;
  let real: ICruiseResult;

  // Each cruise is CPU-bound and takes seconds when the db and design projects run alongside.
  beforeAll(async () => {
    fixtures = await cruiseTree(`${repoRoot}test/fixtures/boundaries`);
    real = await cruiseTree(repoRoot);
  }, 60_000);

  it('flags every seeded violation and nothing else', () => {
    expect(fixtures.summary.violations.map(format).sort()).toEqual(
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
    expect(real.summary.violations).toEqual([]);
    expect(real.summary.totalCruised).toBeGreaterThan(modules.length);
  });

  it.each(modules)('module %s has a public index.ts', (name) => {
    expect(existsSync(`${repoRoot}src/modules/${name}/index.ts`)).toBe(true);
  });
});
