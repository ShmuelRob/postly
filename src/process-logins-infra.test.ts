import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { ALL_LOGINS, PROCESS_LOGINS, poolConnections } from './db/index.js';

// D9 (WP-84): Terraform grants each service account the secrets of its process's logins; the lists in
// infra/modules/stack/main.tf must match src/db/index.ts.

const stack = readFileSync(new URL('../infra/modules/stack/main.tf', import.meta.url), 'utf8');
const list = (name: string) => {
  const start = stack.search(new RegExp(String.raw`\n\s*${name}\s*=\s*\[`));
  if (start < 0) throw new Error(`no ${name} list in main.tf`);
  const body = stack.slice(stack.indexOf('[', start) + 1, stack.indexOf(']', start));
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
};

describe('Terraform login lists', () => {
  it('logins matches ALL_LOGINS', () => expect(list('logins').sort()).toEqual([...ALL_LOGINS].sort()));
  it('console_logins matches PROCESS_LOGINS.console', () => expect(list('console_logins').sort()).toEqual([...PROCESS_LOGINS.console].sort()));
});

// D7 (WP-87): the Terraform connection budget counts every process, the console included, with the
// pool size the code uses.
describe('connection budget', () => {
  it('Terraform passes its pool size to the processes as DB_POOL_MAX', () => {
    expect(stack).toMatch(/pool_max\s*=\s*3\b/);
    expect(stack).toMatch(/DB_POOL_MAX\s*=\s*tostring\(local\.pool_max\)/);
  });

  it('the budget counts the console service', () => {
    const needed = stack.slice(stack.indexOf('connections_needed'), stack.indexOf('\n', stack.indexOf('connections_needed')));
    expect(needed).toContain('console');
  });

  it('poolConnections: each process opens at most poolMax per database login, plus pg-boss', () => {
    expect(poolConnections(PROCESS_LOGINS.console, 3)).toBe((PROCESS_LOGINS.console.length - 1) * 3 + 10);
    expect(poolConnections(ALL_LOGINS, 2)).toBe((ALL_LOGINS.length - 1) * 2 + 10);
  });

  it('DB_POOL_MAX sets the pool size, 3 by default', () => {
    const env = { POSTLY_ENV: 'local', POSTLY_PROVIDERS: 'simulators', DATABASE_URL: 'postgres://db:5432/p', PUBLIC_BASE_URL: 'https://x.test', BUSINESS_NUMBER: '+972500000000', ...Object.fromEntries(ALL_LOGINS.map((l) => [`DB_PASSWORD_${l.toUpperCase()}`, 'pw'])) };
    expect(loadConfig(env).dbPoolMax).toBe(3);
    expect(loadConfig({ ...env, DB_POOL_MAX: '2' }).dbPoolMax).toBe(2);
  });
});
