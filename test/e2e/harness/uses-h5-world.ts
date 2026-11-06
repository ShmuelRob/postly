import { readFileSync } from 'node:fs';

/** Whether the test file builds an H5 world (and is not the file that tests the lock itself). */
export function usesH5World(path: string): boolean {
  if (path.endsWith('shared-database-lock.e2e.test.ts')) return false;
  return /createH5World/.test(readFileSync(path, 'utf8'));
}
