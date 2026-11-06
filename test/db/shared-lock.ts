import { sql } from 'drizzle-orm';
import type { createDatabase } from '../../src/db/index.js';

/**
 * The e2e and H5 files share one Postgres and run in parallel, and some of its state is global: the
 * publishing pause (`system_control`, which defers every business's publications) and the approver
 * numbers (unique per business). A test that sets such state, or whose publications must not be
 * deferred by it, holds this advisory lock while it does. Every H5 world holds it for its whole life
 * (test/h5/subject.ts); a test that publishes without an H5 world holds it around the publish.
 */
export const SHARED_DATABASE_LOCK = 330_033;

let heldByHook = false;

/**
 * The e2e setup hook (test/e2e/harness/shared-lock-hook.ts) holds the lock around a whole test and says so here, so
 * a world built inside the test, which asks for the lock itself, does not wait for the hook that is running it.
 */
export function setLockHeldByHook(held: boolean): void {
  heldByHook = held;
}

/**
 * Waits for the lock and holds it, on one connection of `db`'s pool, until the returned function is
 * called. The lock is a transaction-level one, so it is also released if the connection dies.
 */
export async function holdSharedDatabaseLock(db: ReturnType<typeof createDatabase>): Promise<() => Promise<void>> {
  if (heldByHook) return async () => {};
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const lockTaken = new Promise<void>((resolve) => (locked = resolve));
  const holder = db.withSystem('console', async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SHARED_DATABASE_LOCK})`);
    locked();
    await released;
  });
  // If the holder fails before it locks (no connection), surface that instead of waiting for ever.
  await Promise.race([lockTaken, holder]);
  return async () => {
    release();
    await holder.catch(() => {});
  };
}
