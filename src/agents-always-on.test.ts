import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Config } from './config.js';

// The agents always run in every deployed environment (agent.md, Running on dev). The one-shot flows
// survive only as a composition option (`oneShotFlows`), off by default, that only the tests driving
// them turn on, until A9's cleanup. These checks prove no deployed wiring, the dev sandbox included,
// can turn it on.

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const rel = (path: string) => relative(ROOT, path).replaceAll('\\', '/');
/** Code that sets or reads the option, not comments that name it. */
const USES = /oneShotFlows\??\s*:|\.oneShotFlows\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** Product, sandbox and playground code: everything but tests. */
const code = () => [...files(join(ROOT, 'src')), ...files(join(ROOT, 'playground'))].filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

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
    expect(infra.filter((f) => /one_?shot/i.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([]);
  });

  it('only the compositions name it: app.ts defines it, simulated.ts and the playground pass it through, main.ts turns it off', () => {
    const users = code().filter((f) => USES.test(readFileSync(f, 'utf8'))).map(rel);
    expect(users.sort()).toEqual(['playground/server/playground.ts', 'src/app.ts', 'src/main.ts', 'src/simulated.ts']);
  });

  it('is off by default in every composition, and no product, sandbox or playground code sets it to true', () => {
    expect(read('src/app.ts')).toMatch(/options\.oneShotFlows \?\? false/);
    expect(read('src/simulated.ts')).toMatch(/oneShotFlows: options\.oneShotFlows \?\? false/);
    expect(read('playground/server/playground.ts')).toMatch(/oneShotFlows: options\.oneShotFlows \?\? false/);
    expect(code().filter((f) => /oneShotFlows\s*:\s*true|oneShotFlows\s*\?\?\s*true/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([]);
  });

  it('the dev sandbox never names it, so its composition runs the agents', () => {
    const sandbox = files(join(ROOT, 'playground', 'sandbox')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(sandbox.map(rel)).toContain('playground/sandbox/sandbox.ts');
    expect(sandbox.filter((f) => /oneShot/i.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([]);
  });
});
