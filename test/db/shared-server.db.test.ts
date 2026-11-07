import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { newBusiness } from './rows.js';
import { migrationsHash, runDatabaseName, templateName } from './shared-server.js';
import { startTestDatabase, type TestDatabase } from './start-database.js';

// technical-design.md, "Local test database": on one shared Postgres, each run gets a database of its own,
// copied from the migrated template, so two runs from two worktrees never see each other's data. Locally
// this runs on the shared server when TEST_PG_SERVER_URL is set; in CI on a Postgres of its own.

let container: StartedPostgreSqlContainer | undefined;
let serverUrl: string;
let admin: postgres.Sql;

beforeAll(async () => {
  serverUrl = process.env.TEST_PG_SERVER_URL ?? '';
  if (!serverUrl) {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    serverUrl = container.getConnectionUri();
  }
  admin = postgres(serverUrl, { max: 1, onnotice: () => {} });
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await container?.stop();
});

const exists = async (name: string) => (await admin`select 1 from pg_database where datname = ${name}`).length === 1;
const nameOf = (url: string) => new URL(url).pathname.slice(1);

describe('two runs from two worktrees on one server', { timeout: 180_000 }, () => {
  let a: TestDatabase;
  let b: TestDatabase;

  beforeAll(async () => {
    [a, b] = await Promise.all([
      startTestDatabase({ serverUrl, worktree: 'worktree-a' }),
      startTestDatabase({ serverUrl, worktree: 'worktree-b' }),
    ]);
  }, 180_000);

  afterAll(async () => {
    await a?.stop();
    await b?.stop();
  });

  it('get databases of their own, named after the worktree, from the template for these migrations', async () => {
    const nameA = nameOf(a.urls.business.workflow!);
    const nameB = nameOf(b.urls.business.workflow!);
    expect(nameA).not.toBe(nameB);
    expect(nameA).toMatch(/^postly_run_worktree_a_\d{14}_[0-9a-f]{8}$/);
    expect(nameB).toMatch(/^postly_run_worktree_b_\d{14}_[0-9a-f]{8}$/);
    expect(await exists(templateName(migrationsHash()))).toBe(true);
  });

  it("do not see each other's rows", async () => {
    const dbA = createDatabase(a.urls, { max: 1 });
    const dbB = createDatabase(b.urls, { max: 1 });
    try {
      const inA = await newBusiness(dbA);
      const inB = await newBusiness(dbB);
      const ids = async (db: typeof dbA) => (await db.withSystem('console', (tx) => tx.select({ id: schema.business.id }).from(schema.business))).map((r) => r.id);
      expect(await ids(dbA)).toEqual([inA]);
      expect(await ids(dbB)).toEqual([inB]);
    } finally {
      await dbA.close();
      await dbB.close();
    }
  });

  it('keep the migrated schema and the database privileges: no login may create temporary tables', async () => {
    const db = createDatabase(a.urls, { max: 1 });
    try {
      const rows = await db.withSystem('console', (tx) =>
        tx.execute<{ login: string }>(sql`
          select r.rolname as login from pg_roles r
          where (r.rolname like 'app\\_%' or r.rolname = 'public') and has_database_privilege(r.oid, current_database(), 'TEMPORARY')`),
      );
      expect([...rows]).toEqual([]);
      const [publicTemp] = await db.withSystem('console', (tx) =>
        tx.execute<{ temp: boolean }>(sql`
          select exists (select 1 from pg_database d, aclexplode(d.datacl) x
                         where d.datname = current_database() and x.grantee = 0 and x.privilege_type = 'TEMPORARY') as temp`),
      );
      expect(publicTemp!.temp).toBe(false);
    } finally {
      await db.close();
    }
  });
});

describe('cleanup', { timeout: 180_000 }, () => {
  it('drops the run database when the run stops', async () => {
    const run = await startTestDatabase({ serverUrl, worktree: 'worktree-c' });
    const name = nameOf(run.urls.business.workflow!);
    expect(await exists(name)).toBe(true);
    await run.stop();
    expect(await exists(name)).toBe(false);
  });

  it('drops run databases older than a day on start, and keeps newer ones', async () => {
    const old = runDatabaseName('crashed', new Date(Date.now() - 25 * 60 * 60 * 1000), 'deadbeef');
    const recent = runDatabaseName('running', new Date(Date.now() - 60 * 60 * 1000), 'cafebabe');
    await admin.unsafe(`create database "${old}"`);
    await admin.unsafe(`create database "${recent}"`);
    const run = await startTestDatabase({ serverUrl, worktree: 'worktree-d' });
    try {
      expect(await exists(old)).toBe(false);
      expect(await exists(recent)).toBe(true);
    } finally {
      await run.stop();
      await admin.unsafe(`drop database if exists "${recent}"`);
    }
  });
});
