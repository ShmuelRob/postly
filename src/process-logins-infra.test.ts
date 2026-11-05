import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALL_LOGINS, PROCESS_LOGINS } from './db/index.js';

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
