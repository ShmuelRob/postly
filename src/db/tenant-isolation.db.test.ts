import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, type Tx } from './index.js';
import * as schema from './schema.js';

// Tenant isolation from database-schema.md: as app_user, one business cannot read, insert, update,
// or delete another business's rows on any business-owned table, and without a business context
// nothing is visible or writable.

const db = createDatabase(inject('databaseUrl'), { max: 4 });
afterAll(() => db.close());

/** One valid row per business-owned table (except business), in insert order, for business `b`. */
function rowsFor(b: string): [PgTable, Record<string, unknown>][] {
  const k = () => randomUUID();
  const [channel, msg, media, rule, week, post, version, approval, publication, sub, run, item] = Array.from({ length: 12 }, k);
  const tag = k();
  return [
    [schema.channelConnection, { id: channel, businessId: b, network: 'instagram', provider: 'zernio' }],
    [schema.conversationState, { businessId: b }],
    [
      schema.message,
      {
        id: msg,
        businessId: b,
        direction: 'inbound',
        kind: 'button_reply',
        provider: 'sim',
        providerMessageId: tag,
        fromPhone: '+972500000000',
        toPhone: '+972500000001',
      },
    ],
    [schema.mediaAsset, { id: media, businessId: b, kind: 'photo', source: 'owner', storagePath: `p/${tag}`, mimeType: 'image/jpeg', sha256: 'x' }],
    [schema.preferenceRule, { id: rule, businessId: b, scope: 'caption', rule: 'r', sourceMessageId: msg }],
    [schema.weeklyUpdate, { id: week, businessId: b, weekStart: '2026-11-01' }],
    [schema.post, { id: post, businessId: b, weeklyUpdateId: week, position: 1, format: 'single', plan: {} }],
    [
      schema.postVersion,
      {
        id: version,
        businessId: b,
        postId: post,
        versionNumber: 1,
        captions: {},
        renderedMedia: {},
        factSources: [],
        factCheckPassed: true,
        contentHash: 'h',
      },
    ],
    [
      schema.approval,
      {
        id: approval,
        businessId: b,
        postId: post,
        postVersionId: version,
        approvedVersionHash: 'h',
        approverPhone: '+972500000000',
        messageId: msg,
        approvedAt: new Date(),
      },
    ],
    [
      schema.publication,
      {
        id: publication,
        businessId: b,
        postId: post,
        approvalId: approval,
        approvedVersionHash: 'h',
        channelConnectionId: channel,
        network: 'instagram',
        scheduledFor: new Date(),
      },
    ],
    [schema.subscription, { id: sub, businessId: b, plan: 'basic', provider: 'placeholder' }],
    [schema.modelRun, { id: run, businessId: b, task: 'fact_extraction', promptVersion: 1, provider: 'sim', model: 'm', input: {}, valid: true }],
    [schema.consoleItem, { id: item, businessId: b, kind: 'handoff' }],
  ];
}

const tableName = (t: PgTable) => getTableConfig(t).name;

const businessOwned = Object.values(schema as Record<string, unknown>)
  .filter((v): v is PgTable => v instanceof PgTable)
  .map((t) => getTableConfig(t))
  .filter((c) => c.name === 'business' || c.columns.some((col) => col.name === 'business_id'))
  .map((c) => c.name);

/** The column that identifies a row: id, or business_id for conversation_state. */
const keyOf = (name: string) => (name === 'conversation_state' ? 'business_id' : 'id');

let phone = 0;
async function newBusiness() {
  const id = randomUUID();
  const approverPhone = `+97250${Date.now() % 1e6}${phone++}`;
  await db.withSystem('console', (tx) => tx.insert(schema.business).values({ id, name: `b-${id}`, approverPhone }));
  return id;
}

/** A business and the key of its row in each business-owned table. */
type Seeded = { id: string; keys: Map<string, string> };

async function seed(): Promise<Seeded> {
  const id = await newBusiness();
  const keys = new Map<string, string>([['business', id]]);
  await db.withSystem('console', async (tx) => {
    for (const [table, row] of rowsFor(id)) {
      await tx.insert(table).values(row);
      const name = tableName(table);
      keys.set(name, String(row[name === 'conversation_state' ? 'businessId' : 'id']));
    }
  });
  return { id, keys };
}

/** Drizzle wraps the Postgres error; its message is in cause. */
async function expectDbError(run: Promise<unknown>, pattern: RegExp) {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  const cause = (error as Error).cause;
  expect(cause instanceof Error ? cause.message : (error as Error).message).toMatch(pattern);
}

const count = async (tx: Tx, query: SQL) => (await tx.execute(query)).count;

let a: Seeded;
let b: Seeded;
let empty: string;

beforeAll(async () => {
  a = await seed();
  b = await seed();
  empty = await newBusiness();
});

it('covers every business-owned table in the schema', () => {
  const covered = ['business', ...rowsFor(randomUUID()).map(([t]) => tableName(t))];
  expect([...businessOwned].sort()).toEqual(covered.sort());
});

describe.each(businessOwned)('%s', (name) => {
  const table = sql.identifier(name);
  const key = sql.identifier(keyOf(name));
  const owner = sql.identifier(name === 'business' ? 'id' : 'business_id');

  it('shows a business only its own rows', async () => {
    const owners = await db.withBusiness(a.id, async (tx) =>
      (await tx.execute(sql`select ${owner} as o from ${table}`)).map((r) => r.o),
    );
    expect(owners).toContain(a.id);
    expect(new Set(owners)).toEqual(new Set([a.id]));
  });

  it("cannot read another business's row", async () => {
    const n = await db.withBusiness(a.id, (tx) => count(tx, sql`select 1 from ${table} where ${key} = ${b.keys.get(name)}`));
    expect(n).toBe(0);
  });

  it("cannot update or delete another business's row", async () => {
    const other = b.keys.get(name)!;
    const updated = await db.withBusiness(a.id, (tx) =>
      count(tx, sql`update ${table} set ${key} = ${key} where ${key} = ${other}`),
    );
    const deleted = await db.withBusiness(a.id, (tx) => count(tx, sql`delete from ${table} where ${key} = ${other}`));
    expect([updated, deleted]).toEqual([0, 0]);
    const still = await db.withSystem('console', (tx) => count(tx, sql`select 1 from ${table} where ${key} = ${other}`));
    expect(still).toBe(1);
  });

  it('can update its own row', async () => {
    const own = a.keys.get(name)!;
    const updated = await db.withBusiness(a.id, (tx) =>
      count(tx, sql`update ${table} set ${key} = ${key} where ${key} = ${own}`),
    );
    expect(updated).toBe(1);
  });

  it.skipIf(name === 'business')('cannot move its own row to another business', async () => {
    const own = a.keys.get(name)!;
    await expectDbError(db.withBusiness(a.id, (tx) => tx.execute(sql`update ${table} set business_id = ${b.id} where ${key} = ${own}`)), /row-level security/);
  });
});

describe('inserts', () => {
  it('rejects a business other than the context business', async () => {
    await expectDbError(db.withBusiness(a.id, (tx) => tx.insert(schema.business).values({ name: 'x', approverPhone: '+972599999999' })), /row-level security/);
  });

  it.each(rowsFor(randomUUID()).map(([t]) => tableName(t)))('rejects a %s row for another business', async (name) => {
    // The target business has no rows yet, so nothing but RLS can refuse the insert.
    const [table, row] = rowsFor(empty).find(([t]) => tableName(t) === name)!;
    await expectDbError(db.withBusiness(a.id, (tx) => tx.insert(table).values(row)), /row-level security/);
  });

  it('accepts a full set of rows for the context business', async () => {
    const id = await newBusiness();
    await db.withBusiness(id, async (tx) => {
      for (const [table, row] of rowsFor(id)) await tx.insert(table).values(row);
    });
    expect(await db.withBusiness(id, (tx) => count(tx, sql`select 1 from publication`))).toBe(1);
  });
});

describe('without a business context', () => {
  const raw = postgres(inject('databaseUrl'), { max: 1, onnotice: () => {} });
  afterAll(() => raw.end());

  it.each(businessOwned)('sees no %s rows', async (name) => {
    const rows = await raw.begin(async (tx) => {
      await tx`set local role app_user`;
      return tx`select 1 from ${tx(name)}`;
    });
    expect(rows.count).toBe(0);
  });

  it('cannot insert', async () => {
    await expect(
      raw.begin(async (tx) => {
        await tx`set local role app_user`;
        await tx`insert into console_item (business_id, kind) values (${a.id}, 'handoff')`;
      }),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('rows with a null business_id', () => {
  it('are visible only to app_system', async () => {
    const id = randomUUID();
    await db.withSystem('phone_lookup', (tx) => tx.insert(schema.consoleItem).values({ id, kind: 'unknown_number' }));
    expect(await db.withBusiness(a.id, (tx) => count(tx, sql`select 1 from console_item where id = ${id}`))).toBe(0);
    expect(await db.withSystem('console', (tx) => count(tx, sql`select 1 from console_item where id = ${id}`))).toBe(1);
  });
});

describe('system tables', () => {
  it.each(['model_task_config', 'prompt_template', 'system_control'])('%s is read-only for app_user', async (name) => {
    const table = sql.identifier(name);
    await expect(db.withBusiness(a.id, (tx) => tx.execute(sql`select * from ${table}`))).resolves.toBeDefined();
    await expectDbError(db.withBusiness(a.id, (tx) => tx.execute(sql`delete from ${table}`)), /permission denied/);
  });
});

describe('withBusiness', () => {
  it('rejects a business id that is not a uuid', async () => {
    await expect(db.withBusiness("' or true --", async () => 1)).rejects.toThrow();
  });

  it('does not leak the context into the next transaction on the same connection', async () => {
    const single = createDatabase(inject('databaseUrl'), { max: 1 });
    try {
      await single.withBusiness(a.id, async () => {});
      const [row] = await single.withSystem('console', (tx) =>
        tx.execute(sql`select coalesce(current_setting('app.business_id', true), '') as v, current_user as u`),
      );
      expect(row).toEqual({ v: '', u: 'app_system' });
    } finally {
      await single.close();
    }
  });
});
