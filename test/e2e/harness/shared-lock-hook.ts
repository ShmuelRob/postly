import { afterEach, beforeEach, expect, inject } from 'vitest';
import { createDatabase } from '../../../src/db/index.js';
import { holdSharedDatabaseLock, setLockHeldByHook } from '../../db/shared-lock.js';
import { usesH5World } from './uses-h5-world.js';

// Setup file of the e2e project. An e2e file that runs an H5 world needs the shared database lock for the whole
// of each test (test/db/shared-lock.ts). Taken inside the test, the wait for the lock, behind the other files'
// worlds, counts against the test's timeout; taken here, in a hook, it counts against the hook timeout instead
// (vitest.config.ts), so the tests keep their own short timeouts. While the hook holds the lock, a world that
// asks for it again gets it at once.

let release: (() => Promise<void>) | undefined;
let db: ReturnType<typeof createDatabase> | undefined;

beforeEach(async () => {
  const file = expect.getState().testPath;
  if (!file || !usesH5World(file)) return;
  db = createDatabase(inject('databaseUrls'), { max: 1 });
  release = await holdSharedDatabaseLock(db);
  setLockHeldByHook(true);
});

afterEach(async () => {
  if (!release) return;
  setLockHeldByHook(false);
  await release();
  await db?.close();
  release = undefined;
  db = undefined;
});
