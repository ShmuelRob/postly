import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REAL_MODEL_PROVIDER_NAMES } from './scripted-agent.js';

// The human's rule: no test and no CI run pays for a model (agent.md, Testing without paying for a
// model). The runtime guard is the model layer's (WP-90); these checks hold the files themselves to it.

const ROOT = join(import.meta.dirname, '..', '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'reports', '.claude', 'coverage']);

function files(dir: string, keep: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path, keep) : keep(path) ? [path] : [];
  });
}

const rel = (path: string) => relative(ROOT, path).replaceAll('\\', '/');
const isTest = (path: string) => /\.(test|e2e\.test|db\.test|h5\.test)\.ts$/.test(path);

describe('no paid model in tests or CI', () => {
  it('runs under NODE_ENV=test, which the model layer guard keys on', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });

  it('names every real model adapter, so the e2e harness can refuse it', () => {
    const adapters = files(join(ROOT, 'src', 'modules', 'model-layer', 'adapters'), (p) => p.endsWith('.ts') && !isTest(p));
    expect(adapters.length).toBeGreaterThan(0);
    for (const adapter of adapters) {
      const source = readFileSync(adapter, 'utf8');
      if (!/implements ModelProvider\b/.test(source)) continue;
      const name = source.match(/readonly name = '([^']+)'/)?.[1];
      expect(name, `${rel(adapter)} declares its provider name`).toBeDefined();
      expect(REAL_MODEL_PROVIDER_NAMES, `${rel(adapter)}'s name "${name}"`).toContain(name);
    }
  });

  it("no test builds a real adapter's network transport", () => {
    const tests = ['src', 'test', 'playground', 'scripts'].flatMap((dir) => files(join(ROOT, dir), isTest));
    expect(tests.length).toBeGreaterThan(50);
    const offenders = tests.filter((t) => /\badcTransport\s*\(/.test(readFileSync(t, 'utf8'))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('no CI workflow, npm script, test config or compose file selects a real model', () => {
    const config = [
      ...files(join(ROOT, '.github'), (p) => /\.ya?ml$/.test(p)),
      ...['package.json', 'vitest.config.ts', 'docker-compose.yml', 'compose.yml', 'playground/docker-compose.yml']
        .map((f) => join(ROOT, f))
        .filter(existsSync),
    ];
    expect(config.map(rel)).toContain('package.json');
    const offenders = config.filter((f) => /POSTLY_MODELS\W{0,4}["']?vertex/i.test(readFileSync(f, 'utf8'))).map(rel);
    expect(offenders).toEqual([]);
  });
});
