import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Config } from './config.js';

// The agents always run in every deployed environment (agent.md, Running on dev). The one-shot flows
// survive only as a composition option (`oneShotFlows`) for the tests that drive them and the local
// playground, until A9's cleanup. These checks prove the deployed wiring cannot turn it on.

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('oneShotFlows never reaches a deployed environment', () => {
  it('main.ts, the only deployed entry point, always passes oneShotFlows: false, as a literal', () => {
    const main = read('src/main.ts');
    expect(main.match(/oneShotFlows/g)).toHaveLength(1);
    expect(main).toMatch(/^\s*oneShotFlows: false,$/m);
    // Nothing spread after it in that call could override it.
    const call = main.slice(main.indexOf('createSimulatedApp({'), main.indexOf('});', main.indexOf('createSimulatedApp({')));
    expect(call.trimEnd().endsWith('oneShotFlows: false,')).toBe(true);
  });

  it('no config field, env variable or Terraform value names it', () => {
    expectTypeOf<Config>().not.toHaveProperty('oneShotFlows' as never);
    expect(read('src/config.ts')).not.toMatch(/oneShot|ONE_SHOT/i);
    const infra = files(join(ROOT, 'infra')).filter((f) => /\.(tf|tfvars|example)$/.test(f));
    expect(infra.length).toBeGreaterThan(0);
    const offenders = infra.filter((f) => /one_?shot/i.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('only the compositions set it: app.ts defines it, simulated.ts passes it through, main.ts turns it off', () => {
    const src = files(join(ROOT, 'src')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    // Code that sets or reads it, not comments that name it.
    const users = src.filter((f) => /oneShotFlows\??\s*:|\.oneShotFlows\b/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f).replaceAll('\\', '/'));
    expect(users.sort()).toEqual(['src/app.ts', 'src/main.ts', 'src/simulated.ts']);
  });
});
