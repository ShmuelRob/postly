import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dbError, inserter, seed, type Seeded } from '../../test/db/rows.js';
import { createDatabase } from './index.js';
import * as schema from './schema.js';

// Same-business references from database-schema.md: every foreign key between business-owned
// tables is (business_id, ref) -> (business_id, id), so a business cannot point its own row at
// another business's parent, and cannot probe whether another business's id exists.

const db = createDatabase(inject('databaseUrls'), { max: 2 });
afterAll(() => db.close());

let a: Seeded;
let b: Seeded;
let spareMessageOfB: string;

/** A message of business `id` that no approval uses yet, so approval.message_id stays unique. */
async function spareMessage(id: string): Promise<string> {
  const msg = randomUUID();
  await db.withBusiness('messaging', id, (tx) =>
    tx.insert(schema.message).values({
      id: msg,
      businessId: id,
      direction: 'inbound',
      kind: 'button_reply',
      provider: 'sim',
      providerMessageId: randomUUID(),
      fromPhone: '+972501234567',
      toPhone: '+972501234568',
    }),
  );
  return msg;
}

beforeAll(async () => {
  a = await seed(db);
  b = await seed(db);
  spareMessageOfB = await spareMessage(b.id);
});

// The keys in database-schema.md: from table, the reference column, the parent table, the Drizzle table.
const KEYS: [string, string, string, PgTable][] = [
  ['post', 'weeklyUpdateId', 'weekly_update', schema.post],
  ['post', 'currentVersionId', 'post_version', schema.post],
  ['post_version', 'postId', 'post', schema.postVersion],
  ['preference_rule', 'sourceMessageId', 'message', schema.preferenceRule],
  ['preference_rule', 'sourcePostVersionId', 'post_version', schema.preferenceRule],
  ['approval', 'postId', 'post', schema.approval],
  ['approval', 'postVersionId', 'post_version', schema.approval],
  ['approval', 'messageId', 'message', schema.approval],
  ['publication', 'postId', 'post', schema.publication],
  ['publication', 'approvalId', 'approval', schema.publication],
  ['publication', 'channelConnectionId', 'channel_connection', schema.publication],
];

/** A fresh copy of A's row in `from`, valid on its own: new id, and unique columns made unique again. */
async function freshRowOfA(from: string): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = { ...a.rows.get(from)!, id: randomUUID() };
  if (from === 'post_version') row.versionNumber = Math.floor(Math.random() * 1e6) + 2;
  if (from === 'approval') row.messageId = await spareMessage(a.id);
  if (from === 'publication') row.network = 'facebook';
  return row;
}

const ROLLBACK = new Error('rollback');

describe.each(KEYS)('%s.%s', (from, column, parent, table) => {
  it(`refuses a reference to another business's ${parent}`, async () => {
    const row = await freshRowOfA(from);
    row[column] = from === 'approval' && column === 'messageId' ? spareMessageOfB : b.keys.get(parent);
    const message = await dbError(db.withBusiness(inserter(from), a.id, (tx) => tx.insert(table).values(row)));
    expect(message).toMatch(/violates foreign key constraint ".*_same_business_fk"/);
  });

  it(`accepts a reference to its own business's ${parent}`, async () => {
    // Control for the test above: the same row pointing at A's parent is accepted (then rolled back).
    const row = await freshRowOfA(from);
    if (!(from === 'approval' && column === 'messageId')) row[column] = a.keys.get(parent);
    const outcome = await db
      .withBusiness(inserter(from), a.id, async (tx) => {
        await tx.insert(table).values(row);
        throw ROLLBACK;
      })
      .catch((e: unknown) => e);
    expect(outcome).toBe(ROLLBACK);
  });

  it('gives the same answer for an existing id of another business and an id that does not exist', async () => {
    const attempt = async (target: string) => {
      const row = await freshRowOfA(from);
      row[column] = target;
      return dbError(db.withBusiness(inserter(from), a.id, (tx) => tx.insert(table).values(row)));
    };
    const existing = from === 'approval' && column === 'messageId' ? spareMessageOfB : b.keys.get(parent)!;
    const strip = (m: string) => m.replace(/\(.*\)/g, '');
    expect(strip(await attempt(existing))).toBe(strip(await attempt(randomUUID())));
  });
});

describe('updates', () => {
  it("refuses pointing an existing post at another business's version", async () => {
    const message = await dbError(
      db.withBusiness('content', a.id, (tx) =>
        tx
          .update(schema.post)
          .set({ currentVersionId: b.keys.get('post_version')! })
          .where(eq(schema.post.id, a.keys.get('post')!)),
      ),
    );
    expect(message).toMatch(/violates foreign key constraint "post_current_version_id_same_business_fk"/);
  });

  it("refuses repointing an existing preference rule at another business's message", async () => {
    const message = await dbError(
      db.withBusiness('business_data', a.id, (tx) =>
        tx.execute(sql`update preference_rule set source_message_id = ${b.keys.get('message')} where id = ${a.keys.get('preference_rule')}`),
      ),
    );
    expect(message).toMatch(/violates foreign key constraint "preference_rule_source_message_id_same_business_fk"/);
  });
});
