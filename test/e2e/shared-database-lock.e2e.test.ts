import { afterAll, expect, inject, test } from 'vitest';
import { createDatabase } from '../../src/db/index.js';
import { holdSharedDatabaseLock } from '../db/shared-lock.js';
import { createH5World } from '../h5/world.js';
import { MessagingSimulator, PublishingSimulator } from '../../src/simulators/index.js';

// The e2e files share one Postgres and run in parallel. Some state in it is global: the publishing
// pause (`system_control`) and the approver numbers. A suite that sets that state, or that needs it to
// be as it left it, holds this lock while it does (the H5 worlds hold it for their whole life), so a
// pause one suite sets can never defer another suite's publication.

const db = createDatabase(inject('databaseUrls'), { max: 4 });
afterAll(() => db.close());

const settled = (p: Promise<unknown>) => Promise.race([p.then(() => 'held'), new Promise((r) => setTimeout(() => r('waiting'), 400))]);

test('a second holder waits until the first releases, and then gets the lock', async () => {
  const first = await holdSharedDatabaseLock(db);
  const second = holdSharedDatabaseLock(db);
  expect(await settled(second)).toBe('waiting');
  await first();
  const release = await second;
  await release();
});

test('an H5 world holds the same lock, so a holder waits for the world to close', async () => {
  const world = await createH5World({
    messaging: new MessagingSimulator({ businessNumber: '+972521111199' }),
    publishing: new PublishingSimulator({ now: () => new Date() }),
    now: () => new Date(),
    databaseUrls: inject('databaseUrls'),
  });
  const holder = holdSharedDatabaseLock(db);
  expect(await settled(holder)).toBe('waiting');
  await world.close();
  await (await holder)();
});
