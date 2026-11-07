import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { inserter, newBusiness, seed } from '../../../test/db/rows.js';
import { ONBOARDING_STEPS } from '../../contracts/state-machines/onboarding.js';
import { CONVERSATION_STATES } from '../../contracts/state-machines/conversation.js';
import { BUSINESS_STATES } from '../../contracts/state-machines/business.js';
import { createDatabase, onlyLogins, PROCESS_LOGINS, type Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createWorkflow } from '../workflow/index.js';
import { ConsoleActionError, createConsole } from './index.js';

// The Insights tab (technical-design.md, "Console (Phase 1)"; the definitions are in views.ts,
// Insights). Written from the docs before the implementation. Range figures use a random week long ago
// (1950 to 1989), so no other test's rows fall in it; "now" figures (statuses, funnel) are shared with
// every other test, so they are checked for shape and a lower bound only.

const db = createDatabase(inject('databaseUrls'), { max: 4 });
const consoleDb = createDatabase(onlyLogins(inject('databaseUrls'), PROCESS_LOGINS.console), { max: 2 });
const c = createConsole(consoleDb, createWorkflow(consoleDb, { rejected: () => {} }));
afterAll(async () => {
  await consoleDb.close();
  await db.close();
});

const sys = <T>(fn: (tx: Tx) => Promise<T>) => db.withSystem('console', fn);
const as = <T>(table: string, businessId: string, fn: (tx: Tx) => Promise<T>) => db.withBusiness(inserter(table), businessId, fn);
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * A Saturday long ago: the range is its week, Sunday to Saturday. In the past, not the future, so the
 * overview test's rows stay the newest anywhere (console-views.db.test.ts).
 */
// The insights count every business in the shared test database, so each test needs a week no other
// test uses: a year of its own (a random start, then one year per call), never a random pick that two
// tests can share.
const FIRST_YEAR = 1900 + Math.floor(Math.random() * 40);
let farWeeks = 0;

function farWeek() {
  // In January, so Asia/Jerusalem (the default business timezone) is UTC+2 with no daylight saving:
  // Saturday 21:59 UTC is still Saturday there, and 22:00 UTC is Sunday 00:00, a new business week.
  const base = Date.UTC(FIRST_YEAR + farWeeks++, 0, 2);
  let d = new Date(base + 7 * DAY);
  while (d.getUTCDay() !== 6) d = new Date(d.getTime() + DAY);
  const saturday = d;
  const sunday = new Date(saturday.getTime() - 6 * DAY);
  return { sunday, saturday, at: (dayOffset: number, hour = 12) => new Date(sunday.getTime() + dayOffset * DAY + hour * 3_600_000) };
}

describe('insights', () => {
  it('refuses a range that ends before it starts or spans more than 366 days', async () => {
    for (const range of [
      { from: '2026-11-07', to: '2026-11-01' },
      { from: '2025-01-01', to: '2026-11-07' },
    ]) {
      const error = await c.insights(range).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConsoleActionError);
      expect(error).toMatchObject({ status: 400, reason: 'invalid_range' });
    }
  });

  it('counts the range: new businesses, messages, posts, approvals, agent turns and cost', async () => {
    const w = farWeek();
    const range = { from: iso(w.sunday), to: iso(w.saturday) };
    const now = w.at(6, 13);

    // Businesses: two created in the range (Sunday and Saturday), one the day before it.
    const a = await seed(db);
    const b = await newBusiness(db);
    const early = await newBusiness(db);
    await sys(async (tx) => {
      await tx.update(schema.business).set({ createdAt: w.at(0, 1) }).where(eq(schema.business.id, a.id));
      await tx.update(schema.business).set({ createdAt: w.at(6, 23) }).where(eq(schema.business.id, b));
      await tx.update(schema.business).set({ createdAt: w.at(-1) }).where(eq(schema.business.id, early));
    });

    // Messages: a writes twice and gets one reply; b gets one message and never writes.
    const msg = (businessId: string, direction: 'inbound' | 'outbound', createdAt: Date) => ({
      businessId,
      direction,
      kind: 'text' as const,
      provider: 'sim',
      providerMessageId: randomUUID(),
      fromPhone: '+972501111111',
      toPhone: '+972502222222',
      body: 'שלום',
      createdAt,
    });
    await as('message', a.id, (tx) => tx.insert(schema.message).values([msg(a.id, 'inbound', w.at(1)), msg(a.id, 'inbound', w.at(2)), msg(a.id, 'outbound', w.at(2))]));
    await as('message', b, (tx) => tx.insert(schema.message).values([msg(b, 'outbound', w.at(3)), msg(b, 'outbound', w.at(-2))]));

    // Posts of a: P1 drafted Monday and approved 90 minutes later; P2 drafted Tuesday, its approval
    // invalidated; P3 drafted the week before (out of the range), approved in the range.
    const week = a.keys.get('weekly_update')!;
    // Each approval comes from its own button tap (approval.message_id is unique); taps before the range.
    const taps = [randomUUID(), randomUUID(), randomUUID()];
    await as('message', a.id, (tx) =>
      tx.insert(schema.message).values(taps.map((id) => ({ ...msg(a.id, 'inbound', w.at(-5)), id, kind: 'button_reply' as const, body: null }))),
    );
    const channel = a.keys.get('channel_connection')!;
    const post = (position: number) => ({ id: randomUUID(), businessId: a.id, weeklyUpdateId: week, position: 10 + position, format: 'single' as const, plan: {} });
    // P4 is drafted Wednesday and never approved.
    const [p1, p2, p3, p4] = [post(1), post(2), post(3), post(4)];
    await as('post', a.id, (tx) => tx.insert(schema.post).values([p1, p2, p3, p4]));
    const version = (postId: string, createdAt: Date, hash: string) => ({
      id: randomUUID(),
      businessId: a.id,
      postId,
      versionNumber: 1,
      captions: {},
      renderedMedia: {},
      factSources: [],
      factCheckPassed: true,
      contentHash: hash,
      createdAt,
    });
    const [v1, v2, v3, v4] = [version(p1.id, w.at(1, 10), 'h1'), version(p2.id, w.at(2, 10), 'h2'), version(p3.id, w.at(-3, 10), 'h3'), version(p4.id, w.at(3, 10), 'h4')];
    await as('post_version', a.id, (tx) => tx.insert(schema.postVersion).values([v1, v2, v3, v4]));
    const approval = (v: typeof v1, messageId: string, approvedAt: Date, invalidatedAt: Date | null = null) => ({
      id: randomUUID(),
      businessId: a.id,
      postId: v.postId,
      postVersionId: v.id,
      approvedVersionHash: v.contentHash,
      approverPhone: '+972501234560',
      messageId,
      approvedAt,
      invalidatedAt,
    });
    const a1 = approval(v1, taps[0]!, new Date(v1.createdAt.getTime() + 90 * 60_000));
    const a2 = approval(v2, taps[1]!, w.at(2, 11), w.at(2, 12));
    const a3 = approval(v3, taps[2]!, w.at(0, 10));
    await as('approval', a.id, (tx) => tx.insert(schema.approval).values([a1, a2, a3]));

    // Publications of P1: instagram published Wednesday, facebook failed Thursday; P3: instagram scheduled Friday.
    const pub = (p: typeof p1, ap: typeof a1, network: 'instagram' | 'facebook', scheduledFor: Date, extra: { status?: 'published' | 'failed' | 'scheduled'; publishedAt?: Date; updatedAt?: Date }) => ({
      id: randomUUID(),
      businessId: a.id,
      postId: p.id,
      approvalId: ap.id,
      approvedVersionHash: ap.approvedVersionHash,
      channelConnectionId: channel,
      network,
      scheduledFor,
      ...extra,
    });
    await as('publication', a.id, (tx) =>
      tx.insert(schema.publication).values([
        pub(p1, a1, 'instagram', w.at(3, 9), { status: 'published', publishedAt: w.at(3, 9) }),
        pub(p1, a1, 'facebook', w.at(4, 9), { status: 'failed', updatedAt: w.at(4, 9) }),
        pub(p3, a3, 'instagram', w.at(5, 9), { status: 'scheduled' }),
      ]),
    );

    // Agent turns: three in the range, one handed off; one before it.
    const turn = (startedAt: Date, status: 'done' | 'handed_off') => ({ businessId: a.id, agent: 'weekly' as const, status, trigger: { kind: 'event', name: 't' }, startedAt });
    await as('agent_turn', a.id, (tx) => tx.insert(schema.agentTurn).values([turn(w.at(1), 'done'), turn(w.at(2), 'handed_off'), turn(w.at(3), 'done'), turn(w.at(-1), 'handed_off')]));

    // Model cost: a spends 0.5 on Monday and 0.25 on Saturday; b spends 0.25 on Monday; 7 before the range.
    const run = (businessId: string, createdAt: Date, costUsd: string) => ({ businessId, task: 'fact_extraction' as const, promptVersion: 1, provider: 'sim', model: 'm', input: {}, valid: true, costUsd, createdAt });
    await as('model_run', a.id, (tx) => tx.insert(schema.modelRun).values([run(a.id, w.at(1), '0.5'), run(a.id, w.at(6), '0.25'), run(a.id, w.at(-1), '7')]));
    await as('model_run', b, (tx) => tx.insert(schema.modelRun).values([run(b, w.at(1), '0.25')]));

    const i = await c.insights(range, now);

    expect(i.range).toEqual({ ...range, days: 7 });
    expect(i.newBusinesses.total).toBe(2);
    expect(i.newBusinesses.perDay).toHaveLength(7);
    expect(i.newBusinesses.perDay.map((d) => d.day)).toEqual(Array.from({ length: 7 }, (_, n) => iso(new Date(w.sunday.getTime() + n * DAY))));
    expect(i.newBusinesses.perDay.map((d) => d.n)).toEqual([1, 0, 0, 0, 0, 0, 1]);
    // Business weeks start on Sunday 00:00 in Jerusalem: b joined Saturday 23:00 UTC, which is Sunday
    // 01:00 there, so it counts in the next week (the UTC days above still put it on Saturday).
    expect(i.newBusinesses.perWeek).toEqual([
      { weekStart: range.from, n: 1 },
      { weekStart: iso(new Date(w.sunday.getTime() + 7 * DAY)), n: 1 },
    ]);

    expect(i.messages).toMatchObject({ inbound: 2, outbound: 2, businessesWriting: 1 });
    expect(i.messages.top[0]).toEqual({ businessId: a.id, name: expect.any(String), inbound: 2, outbound: 1 });
    expect(i.messages.top[1]).toEqual({ businessId: b, name: expect.any(String), inbound: 0, outbound: 1 });

    expect(i.posts).toMatchObject({ drafted: 3, approved: 2, published: 1 });
    // In the network enum's order (contracts: instagram, then facebook).
    expect(i.posts.byNetwork).toEqual([
      { network: 'instagram', scheduled: 2, published: 1, failed: 0 },
      { network: 'facebook', scheduled: 1, published: 0, failed: 1 },
    ]);

    // P1, P2 and P4 were first drafted in the range; P1 and P2 have an approval (P2's was invalidated later), P4 none.
    expect(i.approval).toMatchObject({ versioned: 3, approved: 2 });
    expect(i.approval.rate).toBeCloseTo(2 / 3, 6);
    // Approvals in the range: 90 minutes (a1), 60 (a2), and a3, 3 days after its version (4320).
    expect(i.approval.medianMinutes).toBeCloseTo(90, 6);
    expect(i.approval.p90Minutes).toBeGreaterThan(90);
    expect(i.approval.p90Minutes).toBeLessThanOrEqual(4320);

    expect(i.agent).toEqual({ turns: 3, handedOff: 1, handOffRate: 1 / 3 });

    expect(i.cost.totalUsd).toBeCloseTo(1, 6);
    expect(i.cost.perDay).toHaveLength(7);
    expect(i.cost.perDay[1]!.usd).toBeCloseTo(0.75, 6);
    expect(i.cost.perDay[6]!.usd).toBeCloseTo(0.25, 6);
    expect(i.cost.perBusinessUsd).toBeCloseTo(0.5, 6);
  });

  it("reports this week's weekly update for active businesses", async () => {
    const w = farWeek();
    const now = w.at(3, 12);
    const weekStart = iso(w.sunday);
    const states = ['received', 'planned', 'reminded', 'awaiting', 'skipped'] as const;
    for (const status of states) {
      const id = await newBusiness(db);
      await sys((tx) => tx.update(schema.business).set({ status: 'active' }).where(eq(schema.business.id, id)));
      await as('weekly_update', id, (tx) => tx.insert(schema.weeklyUpdate).values({ businessId: id, weekStart, status }));
    }
    // A paused business's row does not count.
    const paused = await newBusiness(db);
    await sys((tx) => tx.update(schema.business).set({ status: 'paused' }).where(eq(schema.business.id, paused)));
    await as('weekly_update', paused, (tx) => tx.insert(schema.weeklyUpdate).values({ businessId: paused, weekStart, status: 'received' }));

    const i = await c.insights({ from: iso(w.sunday), to: iso(w.saturday) }, now);

    expect(i.weekly).toMatchObject({ weekStart, done: 2, reminded: 1, awaiting: 1, skipped: 1 });
    expect(i.weekly.active).toBeGreaterThanOrEqual(5);
    expect(i.weekly.noRow).toBe(i.weekly.active - 5);
  });

  it("counts this week by the business's timezone: Saturday night in Jerusalem is still the old week, until Sunday 00:00", async () => {
    const w = farWeek();
    const next = iso(new Date(w.sunday.getTime() + 7 * DAY));
    const id = await newBusiness(db);
    await sys((tx) => tx.update(schema.business).set({ status: 'active', timezone: 'Asia/Jerusalem' }).where(eq(schema.business.id, id)));
    await as('weekly_update', id, (tx) =>
      tx.insert(schema.weeklyUpdate).values([
        { businessId: id, weekStart: iso(w.sunday), status: 'received' },
        { businessId: id, weekStart: next, status: 'awaiting' },
      ]),
    );
    const range = { from: iso(w.sunday), to: iso(w.saturday) };

    // Saturday 23:59 in Jerusalem (21:59 UTC): this business's week is still the one it answered.
    const saturdayNight = await c.insights(range, new Date(w.saturday.getTime() + 21 * 3_600_000 + 59 * 60_000));
    expect(saturdayNight.weekly).toMatchObject({ weekStart: iso(w.sunday), done: 1, awaiting: 0 });

    // Sunday 00:00 in Jerusalem (Saturday 22:00 UTC): the new week, not answered yet.
    const sunday = await c.insights(range, new Date(w.saturday.getTime() + 22 * 3_600_000));
    expect(sunday.weekly).toMatchObject({ weekStart: next, done: 0, awaiting: 1 });
  });

  it('shows every status and every funnel step in contract order', async () => {
    const onboarding = await newBusiness(db);
    await as('conversation_state', onboarding, (tx) => tx.insert(schema.conversationState).values({ businessId: onboarding, step: 'brand_assets' }));
    const active = await newBusiness(db);
    await sys((tx) => tx.update(schema.business).set({ status: 'active' }).where(eq(schema.business.id, active)));
    await as('conversation_state', active, (tx) => tx.insert(schema.conversationState).values({ businessId: active, step: 'awaiting_answer' }));

    const i = await c.insights({ from: '2026-11-01', to: '2026-11-07' });

    expect(Object.keys(i.statuses)).toEqual([...BUSINESS_STATES]);
    expect(i.statuses.onboarding).toBeGreaterThanOrEqual(1);
    expect(i.statuses.active).toBeGreaterThanOrEqual(1);
    expect(i.funnel.onboarding.map((f) => f.step)).toEqual([...ONBOARDING_STEPS]);
    expect(i.funnel.conversation.map((f) => f.step)).toEqual([...CONVERSATION_STATES]);
    expect(i.funnel.onboarding.find((f) => f.step === 'brand_assets')!.n).toBeGreaterThanOrEqual(1);
    expect(i.funnel.conversation.find((f) => f.step === 'awaiting_answer')!.n).toBeGreaterThanOrEqual(1);
  });
});

describe('business rows for the Businesses tab', () => {
  it('carries each business’s published publications and its model cost', async () => {
    const s = await seed(db);
    // The seed's publication is scheduled; publish it, and add two model runs to the seeded one (cost 0).
    await sys((tx) => tx.update(schema.publication).set({ status: 'published', publishedAt: new Date() }).where(eq(schema.publication.id, s.keys.get('publication')!)));
    const run = (costUsd: string) => ({ businessId: s.id, task: 'fact_extraction' as const, promptVersion: 1, provider: 'sim', model: 'm', input: {}, valid: true, costUsd });
    await as('model_run', s.id, (tx) => tx.insert(schema.modelRun).values([run('0.25'), run('0.5')]));
    const empty = await newBusiness(db);

    const rows = await c.businessRows();
    expect(rows.find((r) => r.id === s.id)).toMatchObject({ published: 1 });
    expect(rows.find((r) => r.id === s.id)!.spendUsd).toBeCloseTo(0.75, 6);
    expect(rows.find((r) => r.id === empty)).toMatchObject({ published: 0, spendUsd: 0 });
  });
});
