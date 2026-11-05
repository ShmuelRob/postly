import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { roleWith } from '../../test/db/grant-matrix.js';
import { expectDbError, inserter, newBusiness, rowsFor, seed, type Seeded, tableName } from '../../test/db/rows.js';
import { BUSINESS_ROLES, type BusinessRole, createDatabase, loginFor, type Tx } from './index.js';
import * as schema from './schema.js';

// Tenant isolation from database-schema.md: under every business role, one business cannot read,
// insert, update, or delete another business's rows on any business-owned table, and without a
// business context nothing is visible or writable. Each check runs as the role the grant matrix
// gives that verb on that table; least-privilege.db.test.ts proves the other roles are refused.

const urls = inject('databaseUrls');
const db = createDatabase(urls, { max: 2 });
afterAll(() => db.close());

const businessOwned = Object.values(schema as Record<string, unknown>)
  .filter((v): v is PgTable => v instanceof PgTable)
  .map((t) => getTableConfig(t))
  .filter((c) => c.name === 'business' || c.columns.some((col) => col.name === 'business_id'))
  .map((c) => c.name);

/** The column that identifies a row: id, or business_id for conversation_state. */
const keyOf = (name: string) => (name === 'conversation_state' ? 'business_id' : 'id');
/** A column the updating role may set in place on each table. */
const touchColumn = (name: string) => (name === 'approval' ? 'invalidated_at' : keyOf(name));

const roleFor = (name: string, verb: 'SELECT' | 'UPDATE' | 'DELETE') => roleWith(name, verb, BUSINESS_ROLES) as BusinessRole | undefined;
const count = async (tx: Tx, query: SQL) => (await tx.execute(query)).count;

let a: Seeded;
let b: Seeded;
let empty: string;

beforeAll(async () => {
  a = await seed(db);
  b = await seed(db);
  empty = await newBusiness(db);
});

it('covers every business-owned table in the schema', () => {
  const covered = ['business', ...rowsFor(randomUUID()).map(([t]) => tableName(t))];
  expect([...businessOwned].sort()).toEqual(covered.sort());
});

describe.each(businessOwned)('%s', (name) => {
  const table = sql.identifier(name);
  const key = sql.identifier(keyOf(name));
  const touch = sql.identifier(touchColumn(name));
  const owner = sql.identifier(name === 'business' ? 'id' : 'business_id');
  const reader = roleFor(name, 'SELECT')!;
  const updater = roleFor(name, 'UPDATE');
  const deleter = roleFor(name, 'DELETE');

  it('shows a business only its own rows', async () => {
    const owners = await db.withBusiness(reader, a.id, async (tx) =>
      (await tx.execute(sql`select ${owner} as o from ${table}`)).map((r) => r.o),
    );
    expect(owners).toContain(a.id);
    expect(new Set(owners)).toEqual(new Set([a.id]));
  });

  it("cannot read another business's row", async () => {
    const n = await db.withBusiness(reader, a.id, (tx) => count(tx, sql`select 1 from ${table} where ${key} = ${b.keys.get(name)}`));
    expect(n).toBe(0);
  });

  it.skipIf(!updater)("cannot update another business's row", async () => {
    const other = b.keys.get(name)!;
    const n = await db.withBusiness(updater!, a.id, (tx) => count(tx, sql`update ${table} set ${touch} = ${touch} where ${key} = ${other}`));
    expect(n).toBe(0);
  });

  it.skipIf(!deleter)("cannot delete another business's row", async () => {
    const other = b.keys.get(name)!;
    expect(await db.withBusiness(deleter!, a.id, (tx) => count(tx, sql`delete from ${table} where ${key} = ${other}`))).toBe(0);
    const still = await db.withSystem('console', (tx) => count(tx, sql`select 1 from ${table} where ${key} = ${other}`));
    expect(still).toBe(1);
  });

  it.skipIf(!updater)('can update its own row', async () => {
    const own = a.keys.get(name)!;
    const n = await db.withBusiness(updater!, a.id, (tx) => count(tx, sql`update ${table} set ${touch} = ${touch} where ${key} = ${own}`));
    expect(n).toBe(1);
  });

  it.skipIf(!updater || name === 'business')('cannot move its own row to another business', async () => {
    const own = a.keys.get(name)!;
    await expectDbError(
      db.withBusiness(updater!, a.id, (tx) => tx.execute(sql`update ${table} set business_id = ${b.id} where ${key} = ${own}`)),
      name === 'approval' ? /permission denied/ : /row-level security/,
    );
  });
});

describe('immutable rows', () => {
  it.each(BUSINESS_ROLES)('post_version cannot be updated or deleted by %s, even in its own business', async (role) => {
    const own = a.keys.get('post_version')!;
    await expectDbError(
      db.withBusiness(role, a.id, (tx) => tx.execute(sql`update post_version set content_hash = 'x' where id = ${own}`)),
      /permission denied/,
    );
    await expectDbError(db.withBusiness(role, a.id, (tx) => tx.execute(sql`delete from post_version where id = ${own}`)), /permission denied/);
  });

  it('approval allows only invalidated_at to change, and is never deleted', async () => {
    const own = a.keys.get('approval')!;
    await expectDbError(
      db.withBusiness('approval', a.id, (tx) => tx.execute(sql`update approval set approved_version_hash = 'x' where id = ${own}`)),
      /permission denied/,
    );
    await expectDbError(db.withBusiness('approval', a.id, (tx) => tx.execute(sql`delete from approval where id = ${own}`)), /permission denied/);
    const n = await db.withBusiness('approval', a.id, (tx) => count(tx, sql`update approval set invalidated_at = now() where id = ${own}`));
    expect(n).toBe(1);
  });
});

describe('inserts', () => {
  it('rejects a business other than the context business', async () => {
    await expectDbError(
      db.withBusiness('workflow', a.id, (tx) => tx.insert(schema.business).values({ name: 'x', approverPhone: '+972501234569' })),
      /row-level security/,
    );
  });

  it.each(rowsFor(randomUUID()).map(([t]) => tableName(t)))('rejects a %s row for another business', async (name) => {
    // The target business has no rows yet, so no unique key refuses first; the RLS message is asserted.
    const [table, row] = rowsFor(empty).find(([t]) => tableName(t) === name)!;
    await expectDbError(db.withBusiness(inserter(name), a.id, (tx) => tx.insert(table).values(row)), /row-level security/);
  });

  it.each([
    ['message', schema.message, { direction: 'inbound', kind: 'text', provider: 'sim', providerMessageId: randomUUID(), fromPhone: '+972501234567', toPhone: '+972501234568' }],
    ['model_run', schema.modelRun, { task: 'fact_extraction', promptVersion: 1, provider: 'sim', model: 'm', input: {}, valid: true }],
    ['console_item', schema.consoleItem, { kind: 'unknown_number' }],
  ] as const)('rejects a %s row with a null business_id', async (name, table, row) => {
    await expectDbError(
      db.withBusiness(inserter(name), a.id, (tx) => tx.insert(table).values({ ...row, businessId: null } as never)),
      /row-level security/,
    );
  });

  it('accepts a full set of rows for the context business', async () => {
    const id = await newBusiness(db);
    for (const [table, row] of rowsFor(id)) await db.withBusiness(inserter(tableName(table)), id, (tx) => tx.insert(table).values(row));
    expect(await db.withBusiness('publishing', id, (tx) => count(tx, sql`select 1 from publication`))).toBe(1);
  });
});

describe('without a business context', () => {
  // Each role's login itself, with no withBusiness() around it, so app.business_id is never set.
  const raw = new Map(BUSINESS_ROLES.map((r) => [r, postgres(urls.business[r]!, { max: 1, onnotice: () => {} })]));
  afterAll(() => Promise.all([...raw.values()].map((c) => c.end())));

  describe.each(businessOwned)('%s', (name) => {
    const updater = roleFor(name, 'UPDATE');
    const deleter = roleFor(name, 'DELETE');
    const owner = name === 'business' ? 'id' : 'business_id';

    it('shows no rows', async () => {
      const c = raw.get(roleFor(name, 'SELECT')!)!;
      expect((await c`select 1 from ${c(name)}`).count).toBe(0);
    });

    it.skipIf(!updater)('updates no rows', async () => {
      const c = raw.get(updater!)!;
      const col = touchColumn(name);
      expect((await c`update ${c(name)} set ${c(col)} = ${c(col)} where ${c(owner)} = ${a.id}`).count).toBe(0);
    });

    it.skipIf(!deleter)('deletes no rows', async () => {
      const c = raw.get(deleter!)!;
      expect((await c`delete from ${c(name)} where ${c(owner)} = ${a.id}`).count).toBe(0);
      expect(await db.withSystem('console', (tx) => count(tx, sql`select 1 from ${sql.identifier(name)} where ${sql.identifier(owner)} = ${a.id}`))).toBe(1);
    });

    it.skipIf(name === 'business')('inserts nothing', async () => {
      const [, row] = rowsFor(a.id).find(([t]) => tableName(t) === name)!;
      const c = raw.get(inserter(name))!;
      await expect(c`insert into ${c(name)} ${c({ business_id: a.id, ...columns(row) })}`).rejects.toThrow(/row-level security/);
    });
  });
});

/** Drizzle row keys to column names and jsonb values to JSON text, for raw inserts. */
function columns(row: Record<string, unknown>): Record<string, never> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([k]) => k !== 'businessId')
      .map(([k, v]) => [k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), (typeof v === 'object' && v !== null && !(v instanceof Date) ? JSON.stringify(v) : v) as never]),
  );
}

describe('rows with a null business_id', () => {
  it('are visible only to system roles', async () => {
    const id = randomUUID();
    await db.withSystem('phone_lookup', (tx) => tx.insert(schema.consoleItem).values({ id, kind: 'unknown_number' }));
    for (const role of BUSINESS_ROLES.filter((r) => roleWith('console_item', 'SELECT', [r]))) {
      expect(await db.withBusiness(role, a.id, (tx) => count(tx, sql`select 1 from console_item where id = ${id}`))).toBe(0);
    }
    expect(await db.withSystem('console', (tx) => count(tx, sql`select 1 from console_item where id = ${id}`))).toBe(1);
  });
});

describe('escapes from inside withBusiness()', () => {
  const visibleOfB = (tx: Tx) => count(tx, sql`select 1 from business where id = ${b.id}`);

  it.each(BUSINESS_ROLES)('%s runs as its own login, which is neither a superuser nor exempt from RLS', async (role) => {
    const [row] = await db.withBusiness(role, a.id, (tx) =>
      tx.execute(
        sql`select current_user as u, (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as strong`,
      ),
    );
    expect(row).toEqual({ u: loginFor(role), strong: false });
  });

  it('reset role stays on the login and sees nothing of B', async () => {
    const [row] = await db.withBusiness('workflow', a.id, async (tx) => {
      await tx.execute(sql`reset role`);
      return tx.execute(sql`select current_user as u, (select count(*)::int from business where id = ${b.id}) as n`);
    });
    expect(row).toEqual({ u: 'app_workflow', n: 0 });
  });

  it.each([
    'set local role app_sys_console',
    'set role app_sys_console',
    'set session authorization app_sys_console',
    'set local role app_publishing',
    'set role app_approval',
  ])('%s is refused', async (statement) => {
    await expectDbError(db.withBusiness('workflow', a.id, (tx) => tx.execute(sql.raw(statement))), /permission denied/);
  });

  it('set role to the table owner is refused', async () => {
    await expectDbError(
      db.withBusiness('workflow', a.id, async (tx) => {
        const [row] = await tx.execute(sql`select tableowner as o from pg_tables where tablename = 'business'`);
        await tx.execute(sql`set role ${sql.identifier(String(row!.o))}`);
      }),
      /permission denied/,
    );
  });

  it('a session-level setting left on a pooled connection does not carry into the next withBusiness()', async () => {
    const single = createDatabase(urls, { max: 1 });
    try {
      const pid = await single.withBusiness('workflow', a.id, async (tx) => {
        await tx.execute(sql`select set_config('app.business_id', ${b.id}, false)`);
        return (await tx.execute(sql`select pg_backend_pid() as p`))[0]!.p;
      });
      const [row] = await single.withBusiness('workflow', a.id, (tx) =>
        tx.execute(sql`select current_setting('app.business_id') as v, current_user as u, pg_backend_pid() as p`),
      );
      expect(row).toEqual({ v: a.id, u: 'app_workflow', p: pid });
      expect(await single.withBusiness('workflow', a.id, visibleOfB)).toBe(0);
    } finally {
      await single.close();
    }
  });

  it('known gap: raw set_config to another business is caught only by the source guard', async () => {
    // database-schema.md, "Accepted risk": Postgres cannot stop a role from changing its own custom
    // settings, so src/db/raw-sql-guard.test.ts bans it outside src/db/. This pins the behavior.
    const n = await db.withBusiness('workflow', a.id, async (tx) => {
      await tx.execute(sql`select set_config('app.business_id', ${b.id}, true)`);
      return visibleOfB(tx);
    });
    expect(n).toBe(1);
  });
});

describe('withBusiness', () => {
  it('rejects a business id that is not a uuid', async () => {
    await expect(db.withBusiness('workflow', "' or true --", async () => 1)).rejects.toThrow();
  });

  it('set_config(..., true), as withBusiness() uses it, ends with the transaction', async () => {
    // Inspected on the connection after commit, outside any transaction: the session holds no business.
    const c = postgres(urls.business.workflow!, { max: 1, onnotice: () => {} });
    try {
      await c.begin((tx) => tx`select set_config('app.business_id', ${a.id}, true)`);
      const [row] = await c`select coalesce(current_setting('app.business_id', true), '') as v, (select count(*)::int from business) as n`;
      expect(row).toEqual({ v: '', n: 0 });
    } finally {
      await c.end();
    }
  });

  it('the next transaction on the same connection sees only its own business', async () => {
    const single = createDatabase(urls, { max: 1 });
    try {
      const first = await single.withBusiness('workflow', a.id, (tx) => tx.execute(sql`select pg_backend_pid() as p`));
      const [row] = await single.withBusiness('workflow', b.id, (tx) =>
        tx.execute(sql`select pg_backend_pid() as p, array_agg(id) as ids from business`),
      );
      expect(row).toEqual({ p: first[0]!.p, ids: [b.id] });
    } finally {
      await single.close();
    }
  });
});
