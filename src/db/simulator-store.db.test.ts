import postgres from 'postgres';
import { afterAll, expect, inject, it } from 'vitest';
import { describeSimulatorStoreContract } from '../simulators/contract-suites/simulator-store.js';
import type { SimulatorStore } from '../simulators/persistent.js';
import { createDatabase } from './index.js';
import { createPostgresSimulatorStore } from './simulator-store.js';

// Simulated mode in dev (WP-51): the simulators' state in the `simulator` schema, through the
// `app_simulator` login only (docs/deployment.md, "Simulated mode").
const stores: Array<SimulatorStore & { close(): Promise<void> }> = [];
afterAll(async () => {
  for (const s of stores) await s.close();
});

describeSimulatorStoreContract('postgres', () => {
  const store = createPostgresSimulatorStore(inject('simulatorStoreUrl'));
  stores.push(store);
  return store;
});

it('the simulator login is no superuser, bypasses no RLS, inherits nothing and creates no roles or databases', async () => {
  const admin = postgres(inject('simulatorStoreUrl'), { max: 1, onnotice: () => {} });
  try {
    const [r] = await admin`select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin, rolinherit from pg_roles where rolname = current_user`;
    expect([r?.rolsuper, r?.rolbypassrls, r?.rolcreaterole, r?.rolcreatedb, r?.rolcanlogin, r?.rolinherit]).toEqual([false, false, false, false, true, false]);
  } finally {
    await admin.end();
  }
});

it('the simulator login reaches no business table, and the business roles cannot reach the simulator schema', async () => {
  const simulator = postgres(inject('simulatorStoreUrl'), { max: 1, onnotice: () => {} });
  try {
    await expect(simulator.unsafe('select count(*) from public.business')).rejects.toThrow(/permission denied/);
  } finally {
    await simulator.end();
  }
  const db = createDatabase(inject('databaseUrls'), { max: 1 });
  try {
    // Drizzle wraps the driver's error; the Postgres message is its cause.
    const error = (await db.withSystem('console', (tx) => tx.execute('select count(*) from simulator.state')).catch((e: unknown) => e)) as Error & { cause?: unknown };
    expect(String(error.cause ?? error)).toMatch(/permission denied/);
  } finally {
    await db.close();
  }
});
