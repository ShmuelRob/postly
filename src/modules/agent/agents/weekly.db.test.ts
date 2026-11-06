import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import type { AgentToolResult } from '../../../contracts/agent.js';
import type { PlannedPost } from '../../../contracts/content.js';
import type { SendTextRequest } from '../../../contracts/providers/messaging.js';
import { createDatabase } from '../../../db/index.js';
import * as schema from '../../../db/schema.js';
import { ModelSimulator } from '../../../simulators/model.js';
import { call, type ScriptEntry, step } from '../../../simulators/scripted-agent.js';
import { createModelLayer } from '../../model-layer/index.js';
import { createAgent, type AgentDeps } from '../index.js';
import { weeklyAgent } from './weekly.js';

// The weekly-update agent (WP-93; agent.md: Agents, record_fact, plan_posts) on the scripted agent and
// the migrated database. No test calls a real model.

const db = createDatabase(inject('databaseUrls'), { max: 3 });
afterAll(() => db.close());

const UPDATE = 'השבוע 20% הנחה על כל זרי הסתיו';
const DAY_MS = 86_400_000;

let businessId: string;
let approver: string;
let weekId: string;
let sim: ModelSimulator;
let sent: SendTextRequest[];
let stored: { weekId: string; posts: PlannedPost[] }[];
/** Every call's result, in order, as the runtime reported it (onTurnEnd); null for a call that never ran. */
let reported: (AgentToolResult | null)[];
const onTurnEnd: AgentDeps['onTurnEnd'] = (t) => void reported.push(...t.steps.flatMap((s) => s.results));

const messaging: AgentDeps['messaging'] = {
  async sendText(_b, request) {
    sent.push(request);
    return { providerMessageId: randomUUID() };
  },
};

/** The workflow's side of plan_posts in these tests: the week becomes `planned` with one post per planned post. */
const planStored: NonNullable<AgentDeps['events']['planStored']> = async (b, input) => {
  stored.push(input);
  return db.withBusiness('workflow', b, async (tx) => {
    const [week] = await tx.select().from(schema.weeklyUpdate).where(eq(schema.weeklyUpdate.id, input.weekId));
    if (week?.status !== 'received') return null;
    await tx.update(schema.weeklyUpdate).set({ status: 'planned' }).where(eq(schema.weeklyUpdate.id, input.weekId));
    const rows = await tx
      .insert(schema.post)
      .values(input.posts.map((p, position) => ({ businessId: b, weeklyUpdateId: input.weekId, position, format: p.format, plan: p })))
      .returning({ id: schema.post.id });
    return rows.map((r) => r.id);
  });
};

const agent = (events: Partial<AgentDeps['events']> = {}) =>
  createAgent({
    db,
    models: createModelLayer({ db, providers: { google: sim } }),
    messaging,
    events: { questionAsked: async () => {}, planStored, ...events },
    onTurnEnd,
  });

const turn = (...entries: ScriptEntry[]) => {
  sim.scriptAgent('weekly', entries);
  return agent().runTurn(businessId, 'weekly', { kind: 'event', name: 'test' });
};

async function message(body: string, options: { at?: Date; photos?: string[]; direction?: 'inbound' | 'outbound' } = {}) {
  await db.withBusiness('messaging', businessId, (tx) =>
    tx.insert(schema.message).values({
      businessId,
      direction: options.direction ?? 'inbound',
      kind: options.photos?.length ? 'image' : 'text',
      provider: 'sim',
      providerMessageId: randomUUID(),
      fromPhone: approver,
      toPhone: '+972500000000',
      body,
      mediaAssetIds: options.photos ?? [],
      ...(options.at ? { createdAt: options.at } : {}),
    }),
  );
}

async function newBusiness(week: { status?: 'received' | 'planned' | 'awaiting'; photos?: string[]; transcript?: string } = {}) {
  businessId = randomUUID();
  approver = `+9725${Math.floor(1e7 + Math.random() * 9e7)}`;
  weekId = randomUUID();
  const receivedAt = new Date(Date.now() - 60_000);
  await db.withBusiness('workflow', businessId, async (tx) => {
    await tx.insert(schema.business).values({
      id: businessId,
      name: 'פרחי דנה',
      status: 'active',
      approverPhone: approver,
      profile: { name: 'פרחי דנה', approverPhone: approver, postsPerWeek: 3, formats: ['single', 'carousel'] },
    });
    await tx.insert(schema.conversationState).values({ businessId, step: 'processing_update' });
    await tx.insert(schema.weeklyUpdate).values({
      id: weekId,
      businessId,
      weekStart: new Date(Date.now() - 2 * DAY_MS).toISOString().slice(0, 10),
      status: week.status ?? 'received',
      originalText: UPDATE,
      transcript: week.transcript ?? null,
      mediaAssetIds: week.photos ?? [],
      receivedAt,
    });
  });
  await message(UPDATE, { at: new Date(receivedAt.getTime() - 1000) });
}

const weekRow = () => db.withBusiness('workflow', businessId, async (tx) => (await tx.select().from(schema.weeklyUpdate).where(eq(schema.weeklyUpdate.id, weekId)))[0]!);
const facts = async () => ((await weekRow()).extractedFacts as { facts: { id: string; type: string; value: string; sourceQuote: string }[] } | null)?.facts ?? [];
const posts = () => db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.post).where(eq(schema.post.weeklyUpdateId, weekId)).orderBy(schema.post.position));

/** The result of every call the scripted agent made, in order. */
const results = (): AgentToolResult[] => reported.filter((r): r is AgentToolResult => r !== null);

const discount = (value = '20', sourceQuote = '20% הנחה') => call.recordFact({ type: 'discount_percent', value, sourceQuote });
const planned = (overrides: Partial<PlannedPost> = {}): PlannedPost => ({
  topic: 'מבצע זרי סתיו',
  contentType: 'promotions',
  format: 'single',
  factIds: ['f1'],
  mediaAssetIds: [],
  brief: 'פוסט על 20% הנחה',
  ...overrides,
});
const END = call.endTurn();

beforeEach(async () => {
  await newBusiness();
  sim = new ModelSimulator({ defaults: false });
  sent = [];
  stored = [];
  reported = [];
});
afterEach(() => expect(sim.agentScriptProblems()).toEqual([]));

describe('the weekly agent (agent.md, Agents)', () => {
  it('has the tools of its row: ask_owner, record_fact, request_photo, record_decline, plan_posts, set_profile_field (A7), hand-off, end_turn', () => {
    expect([...weeklyAgent.tools].sort()).toEqual(
      ['ask_owner', 'record_fact', 'request_photo', 'record_decline', 'plan_posts', 'set_profile_field', 'hand_off_to_console', 'end_turn'].sort(),
    );
    expect(weeklyAgent.task).toBe('agent_weekly');
  });

  it('is done once the plan is stored (the week is planned)', async () => {
    expect(await weeklyAgent.isDone({ businessId, db, turnId: randomUUID() })).toBe(false);
    await db.withBusiness('workflow', businessId, (tx) => tx.update(schema.weeklyUpdate).set({ status: 'planned' }).where(eq(schema.weeklyUpdate.id, weekId)));
    expect(await weeklyAgent.isDone({ businessId, db, turnId: randomUUID() })).toBe(true);
  });
});

describe('record_fact (agent.md)', () => {
  it("records a fact quoted from the update, with a new id, in the week's extracted facts", async () => {
    await turn(step(discount()), step(END));
    expect(results()).toEqual([{ status: 'ok', data: { factId: 'f1' } }, { status: 'ok', data: {} }]);
    expect(await facts()).toEqual([{ id: 'f1', type: 'discount_percent', value: '20', sourceQuote: '20% הנחה' }]);
  });

  it('numbers facts in order and keeps the earlier ones', async () => {
    await turn(step(discount(), call.recordFact({ type: 'product', value: 'זרי סתיו', sourceQuote: 'זרי הסתיו' })), step(END));
    expect((await facts()).map((f) => f.id)).toEqual(['f1', 'f2']);
  });

  it('refuses a quote that is not in the update or an answer this week, and stores nothing', async () => {
    await turn(step(discount('20', '20% הנחה על כל הפרחים')), step(END));
    expect(results()[0]).toMatchObject({ status: 'refused', reason: 'quote_not_found' });
    expect(await facts()).toEqual([]);
  });

  it("accepts a quote from the owner's answer after the update, but not from a message before this week", async () => {
    await message('עד יום חמישי');
    await message('המבצע של החודש שעבר: 30% הנחה', { at: new Date(Date.now() - 5 * DAY_MS) });
    await turn(
      step(call.recordFact({ type: 'date', value: 'יום חמישי', sourceQuote: 'עד יום חמישי' })),
      step(call.recordFact({ type: 'discount_percent', value: '30', sourceQuote: '30% הנחה' })),
      step(END),
    );
    expect(results().map((r) => r.status)).toEqual(['ok', 'refused', 'ok']);
    expect(results()[1]).toMatchObject({ reason: 'quote_not_found' });
  });

  it('refuses a price, discount, date, time or phone whose value is not in its quote', async () => {
    await turn(step(discount('15')), step(END));
    expect(results()[0]).toMatchObject({ status: 'refused', reason: 'value_not_in_quote' });
    expect(await facts()).toEqual([]);
  });

  it('takes a testimonial only from text the owner typed, never from a transcript', async () => {
    await newBusiness({ transcript: 'לקוחה אמרה שהזר הכי יפה שראתה' });
    sim = new ModelSimulator({ defaults: false });
    await turn(step(call.recordFact({ type: 'testimonial', value: 'הזר הכי יפה', sourceQuote: 'הזר הכי יפה שראתה' })), step(END));
    expect(results()[0]).toMatchObject({ status: 'refused', reason: 'quote_not_found' });
    await turn(step(call.recordFact({ type: 'product', value: 'זר', sourceQuote: 'הזר הכי יפה שראתה' })), step(END));
    expect(results()[2]).toEqual({ status: 'ok', data: { factId: 'f1' } });
  });

  it('replaces an earlier fact it corrects, and refuses an unknown one', async () => {
    await message('סליחה, 25% הנחה');
    await turn(step(discount()), step(call.recordFact({ type: 'discount_percent', value: '25', sourceQuote: '25% הנחה', replaces: 'f1' })), step(END));
    expect(await facts()).toEqual([{ id: 'f2', type: 'discount_percent', value: '25', sourceQuote: '25% הנחה' }]);
    await turn(step(call.recordFact({ type: 'discount_percent', value: '25', sourceQuote: '25% הנחה', replaces: 'f9' })), step(END));
    expect(results().at(-2)).toMatchObject({ status: 'refused', reason: 'unknown_id' });
  });

  it('refuses when the week has no update being gathered', async () => {
    await newBusiness({ status: 'planned' });
    sim = new ModelSimulator({ defaults: false });
    // A planned week is the done rule, so the turn stops right after the refusal.
    await turn(step(discount()));
    expect(results()[0]).toMatchObject({ status: 'refused', reason: 'not_allowed' });
  });
});

describe('plan_posts (agent.md)', () => {
  const three = (overrides: Partial<PlannedPost> = {}) => [planned(overrides), planned({ ...overrides, topic: 'טיפ לטיפוח זר' }), planned({ ...overrides, topic: 'מאחורי הקלעים' })];

  it('an initial plan of postsPerWeek posts is stored through the workflow, and the agent is done', async () => {
    const result = await turn(step(discount()), step(call.planPosts({ mode: 'initial', posts: three() })));
    expect(result).toMatchObject({ status: 'done', stopReason: 'done' });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.posts.map((p) => p.topic)).toEqual(['מבצע זרי סתיו', 'טיפ לטיפוח זר', 'מאחורי הקלעים']);
    expect(results()[1]).toEqual({ status: 'ok', data: { postIds: (await posts()).map((p) => p.id) } });
  });

  it('refuses a plan with the wrong count, unless the owner asked for it this week', async () => {
    await turn(step(discount()), step(call.planPosts({ mode: 'initial', posts: three().slice(0, 2) })), step(END));
    expect(results()[1]).toMatchObject({ status: 'refused', reason: 'plan_invalid' });
    expect(stored).toEqual([]);

    await message('השבוע רק שני פוסטים בבקשה');
    await turn(step(call.planPosts({ mode: 'initial', posts: three().slice(0, 2), ownerQuote: 'רק שני פוסטים' })));
    expect(stored).toHaveLength(1);
  });

  it('refuses an owner quote for the count that the owner never wrote', async () => {
    await turn(step(discount()), step(call.planPosts({ mode: 'initial', posts: three().slice(0, 2), ownerQuote: 'רק שני פוסטים' })), step(END));
    expect(results()[1]).toMatchObject({ status: 'refused', reason: 'plan_invalid' });
  });

  it('refuses unknown facts, a format the profile does not have, and photos that are not from this week', async () => {
    await newBusiness({ photos: [randomUUID()] });
    sim = new ModelSimulator({ defaults: false });
    const [photo] = (await weekRow()).mediaAssetIds;
    await turn(
      step(discount()),
      step(call.planPosts({ mode: 'initial', posts: three({ factIds: ['f7'] }) })),
      step(call.planPosts({ mode: 'initial', posts: [planned({ format: 'carousel', mediaAssetIds: [photo!, randomUUID()] }), ...three().slice(1)] })),
      step(END),
    );
    expect(results().slice(1, 3)).toEqual([
      expect.objectContaining({ status: 'refused', reason: 'plan_invalid', detail: expect.stringContaining('f7') }),
      expect.objectContaining({ status: 'refused', reason: 'plan_invalid', detail: expect.stringContaining('photo') }),
    ]);
  });

  it("accepts this week's photos, from the update or a later message, in the right number per format", async () => {
    const later = randomUUID();
    await newBusiness({ photos: [randomUUID()] });
    sim = new ModelSimulator({ defaults: false });
    await message('', { photos: [later] });
    const [fromUpdate] = (await weekRow()).mediaAssetIds;
    await turn(
      step(discount()),
      step(call.planPosts({ mode: 'initial', posts: [planned({ mediaAssetIds: [fromUpdate!, later] }), ...three().slice(1)] })),
      step(call.planPosts({ mode: 'initial', posts: [planned({ format: 'carousel', mediaAssetIds: [fromUpdate!] }), ...three().slice(1)] })),
      step(call.planPosts({ mode: 'initial', posts: [planned({ format: 'carousel', mediaAssetIds: [fromUpdate!, later] }), ...three().slice(1)] })),
    );
    expect(results().slice(1).map((r) => (r.status === 'refused' ? r.reason : r.status))).toEqual(['plan_invalid', 'plan_invalid', 'ok']);
  });

  it('a format outside the profile needs the owner to have asked for it', async () => {
    await db.withBusiness('workflow', businessId, (tx) =>
      tx.update(schema.business).set({ profile: { name: 'פרחי דנה', approverPhone: approver, postsPerWeek: 3, formats: ['single'] } }).where(eq(schema.business.id, businessId)),
    );
    await message('תעשי קרוסלה מהתמונות', { photos: [randomUUID(), randomUUID()] });
    const photos = await db.withBusiness('workflow', businessId, async (tx) => (await tx.select().from(schema.message)).flatMap((m) => m.mediaAssetIds));
    const carousel = [planned({ format: 'carousel', mediaAssetIds: photos }), ...three().slice(1)];
    await turn(step(discount()), step(call.planPosts({ mode: 'initial', posts: carousel })), step(call.planPosts({ mode: 'initial', posts: carousel, ownerQuote: 'תעשי קרוסלה' })));
    expect(results().slice(1).map((r) => r.status)).toEqual(['refused', 'ok']);
  });

  it('refuses an initial plan once the week is planned, and a revised plan before it is', async () => {
    await turn(step(discount()), step(call.planPosts({ mode: 'revise', posts: [{ ...planned(), postId: randomUUID() }] })), step(END));
    expect(results()[1]).toMatchObject({ status: 'refused', reason: 'not_allowed' });
    await turn(step(call.planPosts({ mode: 'initial', posts: three() })));
    // The week is planned, so the agent is done right after the refusal.
    await turn(step(call.planPosts({ mode: 'initial', posts: three() })));
    expect(results().at(-1)).toMatchObject({ status: 'refused', reason: 'not_allowed' });
  });

  it('revise changes only posts without a version, and may add a planned post the owner asked for', async () => {
    await turn(step(discount()), step(call.planPosts({ mode: 'initial', posts: three() })));
    await message('תוסיפי עוד פוסט על זר נוסף');
    const [first, second] = await posts();
    await db.withBusiness('workflow', businessId, (tx) => tx.update(schema.post).set({ status: 'awaiting_approval' }).where(eq(schema.post.id, second!.id)));
    sim.scriptAgent('drafts', [
      step(call.planPosts({ mode: 'revise', posts: [{ ...planned({ topic: 'שני זרים לבחירה' }), postId: first!.id }, planned({ topic: 'זר נוסף' })], ownerQuote: 'עוד פוסט' })),
      step(call.planPosts({ mode: 'revise', posts: [{ ...planned({ topic: 'אחר' }), postId: second!.id }] })),
      step(call.planPosts({ mode: 'initial', posts: three() })),
      step(END),
    ]);
    const drafts = { ...(await import('./index.js')).agents.drafts, tools: ['plan_posts', 'end_turn'] as const };
    await createAgent({
      db,
      models: createModelLayer({ db, providers: { google: sim } }),
      messaging,
      events: { questionAsked: async () => {}, planStored },
      agents: { ...(await import('./index.js')).agents, drafts },
      onTurnEnd,
    }).runTurn(businessId, 'drafts', { kind: 'event', name: 'test' });
    const drafted = results().slice(2);
    expect(drafted.map((r) => (r.status === 'refused' ? r.reason : r.status))).toEqual(['ok', 'plan_invalid', 'not_allowed', 'ok']);
    expect((await posts()).map((p) => [(p.plan as PlannedPost).topic, p.status])).toEqual([
      ['שני זרים לבחירה', 'planned'],
      ['טיפ לטיפוח זר', 'awaiting_approval'],
      ['מאחורי הקלעים', 'planned'],
      ['זר נוסף', 'planned'],
    ]);
  });
});
