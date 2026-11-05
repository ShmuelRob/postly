import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { newBusiness, seed, type Seeded } from '../../test/db/rows.js';
import { createDatabase } from './index.js';
import * as schema from './schema.js';

// The statements the human-owned H5 tests (test/h5/db.ts) run through withSystem('console'), copied
// here so a missing console grant fails on every run, not only once H5 is unblocked. A change to
// test/h5/db.ts that adds a statement needs the same statement here and, if new, a grant in
// database-schema.md first.

const db = createDatabase(inject('databaseUrls'), { max: 2 });
afterAll(() => db.close());

const asConsole = (query: SQL) => db.withSystem('console', async (tx) => (await tx.execute(query)) as unknown as Record<string, unknown>[]);

let a: Seeded;
beforeAll(async () => {
  a = await seed(db);
  // A second channel, so a forged facebook publication does not collide with the seeded instagram one.
  await db.withBusiness('publishing', a.id, (tx) =>
    tx.insert(schema.channelConnection).values({ businessId: a.id, network: 'facebook', provider: 'zernio' }),
  );
});

describe('H5 console statements', () => {
  it('reads post status, approvals, publications and their count', async () => {
    const post = a.keys.get('post')!;
    expect(await asConsole(sql`select status from post where id = ${post}`)).toHaveLength(1);
    expect(
      await asConsole(
        sql`select id, approved_version_hash, invalidated_at, approver_phone from approval where post_id = ${post} order by approved_at`,
      ),
    ).toHaveLength(1);
    const publication = a.keys.get('publication')!;
    expect(await asConsole(sql`select status, provider_post_id, attempts from publication where id = ${publication}`)).toHaveLength(1);
    expect(await asConsole(sql`select count(*)::int as n from publication`)).toHaveLength(1);
  });

  it('sets and clears the global pause', async () => {
    for (const paused of [true, false]) {
      await asConsole(
        sql`insert into system_control (id, publishing_paused) values (1, ${paused}) on conflict (id) do update set publishing_paused = ${paused}`,
      );
    }
  });

  it('pauses and resumes a business', async () => {
    for (const paused of [true, false]) {
      await asConsole(sql`update business set status = ${paused ? 'paused' : 'active'} where id = ${a.id}`);
    }
  });

  it('starts and ends a handoff, with and without a conversation row', async () => {
    const fresh = await newBusiness(db); // no conversation_state row yet: the insert path
    for (const [id, on] of [
      [a.id, true],
      [a.id, false],
      [fresh, true],
    ] as const) {
      await asConsole(
        sql`insert into conversation_state (business_id, handoff_at) values (${id}, ${on ? sql`now()` : null})
            on conflict (business_id) do update set handoff_at = excluded.handoff_at`,
      );
    }
  });

  it('forges a publication and marks it retry_pending', async () => {
    const [inserted] = await asConsole(sql`
      insert into publication (business_id, post_id, approval_id, approved_version_hash, channel_connection_id, network, scheduled_for)
      select ${a.id}, ${a.keys.get('post')!}, ${a.keys.get('approval')!}, ${'h'}, c.id, ${'facebook'}, ${new Date().toISOString()}
      from channel_connection c where c.business_id = ${a.id} and c.network = ${'facebook'}
      returning id`);
    expect(inserted?.id).toBeDefined();
    await asConsole(
      sql`update publication set status = 'retry_pending', provider_post_id = ${'p-1'}, attempts = 1 where id = ${String(inserted!.id)}`,
    );
  });
});

// T11 (security.md D5): the console login bypasses RLS, so its updates are limited by column. It may
// not move a row to another business or re-key it; Postgres refuses the statement before any row.
describe('console cannot move a row between businesses', () => {
  const refused = /permission denied for table/;
  let b: string;
  beforeAll(async () => {
    b = await newBusiness(db);
  });

  it.each(['channel_connection', 'conversation_state', 'post', 'publication', 'console_item'])(
    'refuses an update of %s.business_id',
    async (table) => {
      const message = await asConsole(sql`update ${sql.identifier(table)} set business_id = ${b} where business_id = ${a.id}`).then(
        () => '',
        (e: Error) => (e.cause instanceof Error ? e.cause.message : e.message),
      );
      expect(message).toMatch(refused);
    },
  );

  it.each(['channel_connection', 'post', 'publication', 'console_item'])('refuses an update of %s.id', async (table) => {
    const message = await asConsole(sql`update ${sql.identifier(table)} set id = gen_random_uuid() where business_id = ${a.id}`).then(
      () => '',
      (e: Error) => (e.cause instanceof Error ? e.cause.message : e.message),
    );
    expect(message).toMatch(refused);
  });

  it('refuses an update of business.id', async () => {
    const message = await asConsole(sql`update business set id = gen_random_uuid() where id = ${a.id}`).then(
      () => '',
      (e: Error) => (e.cause instanceof Error ? e.cause.message : e.message),
    );
    expect(message).toMatch(refused);
  });

  it('still resolves a console item', async () => {
    await asConsole(sql`update console_item set status = 'resolved', resolved_at = now(), updated_at = now() where business_id = ${a.id}`);
  });
});
