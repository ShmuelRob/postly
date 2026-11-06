import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { usesH5World } from './uses-h5-world.js';

// The e2e files that run an H5 world take the shared database lock before each test, in a hook, so the wait
// for the lock is not part of the test's own timeout (vitest.config.ts, the e2e project).

const E2E_DIR = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = readdirSync(E2E_DIR).filter((f) => f.endsWith('.e2e.test.ts'));

describe('usesH5World', () => {
  it('is true for every e2e file that builds an H5 world, so none is left out of the hook', () => {
    const builders = files.filter((f) => /createH5World/.test(readFileSync(join(E2E_DIR, f), 'utf8')) && f !== 'shared-database-lock.e2e.test.ts');
    expect(builders.length).toBeGreaterThanOrEqual(8);
    for (const f of builders) expect(usesH5World(join(E2E_DIR, f)), f).toBe(true);
  });

  it('is false for files that never build one, and for the file that tests the lock itself', () => {
    for (const f of ['simulated-dev.e2e.test.ts', 'drafts-agent.e2e.test.ts', 'onboarding.e2e.test.ts', 'shared-database-lock.e2e.test.ts']) {
      expect(usesH5World(join(E2E_DIR, f)), f).toBe(false);
    }
  });
});
