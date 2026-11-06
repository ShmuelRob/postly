import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import type { AgentContext, AgentToolResult } from '../../../contracts/agent.js';
import type { ChannelCaptions, PlannedPost } from '../../../contracts/content.js';
import type { DesignSpec } from '../../../contracts/design-spec.js';
import type { SendTextRequest } from '../../../contracts/providers/messaging.js';
import { createDatabase } from '../../../db/index.js';
import * as schema from '../../../db/schema.js';
import { ModelSimulator } from '../../../simulators/model.js';
import { call, type ScriptEntry, step } from '../../../simulators/scripted-agent.js';
import { createModelLayer } from '../../model-layer/index.js';
import { createAgent, type AgentDeps } from '../index.js';
import { buildContext } from '../context.js';
import type { DraftOutcome } from '../tools/drafts.js';
import { draftsAgent } from './drafts.js';

// The drafts agent (WP-94; agent.md: Agents, create_draft, apply_change) on the scripted agent and the
// migrated database: the tools' own checks, the context builder's additions, and the done rule. The
// workflow's side (render, version, send) is stubbed here and covered by test/e2e/drafts-agent.e2e.test.ts.
// No test calls a real model.

const db = createDatabase(inject('databaseUrls'), { max: 4 });
afterAll(() => db.close());

const DAY_MS = 86_400_000;
const UPDATE = 'השבוע 20% הנחה על כל זרי הסתיו, עד יום חמישי';

let businessId: string;
let approver: string;
let weekId: string;
let photoId: string;
let smallPhotoId: string;
let sim: ModelSimulator;
let reported: (AgentToolResult | null)[];
let created: Parameters<NonNullable<AgentDeps['events']['draftCreated']>>[1][];
let changed: Parameters<NonNullable<AgentDeps['events']['changeApplied']>>[1][];
let outcome: DraftOutcome;
let holiday: boolean;
const onTurnEnd: AgentDeps['onTurnEnd'] = (t) => void reported.push(...t.steps.flatMap((s) => s.results));

const messaging: AgentDeps['messaging'] = { async sendText(_b: string, _r: SendTextRequest) { return { providerMessageId: randomUUID() }; } };

const agent = () =>
  createAgent({
    db,
    models: createModelLayer({ db, providers: { google: sim } }),
    messaging,
    events: {
      questionAsked: async () => {},
      draftCreated: async (_b, input) => (created.push(input), outcome),
      changeApplied: async (_b, input) => (changed.push(input), outcome),
      holidayInWeek: async () => holiday,
    },
    onTurnEnd,
  });

const turn = (...entries: ScriptEntry[]) => {
  sim.scriptAgent('drafts', entries);
  return agent().runTurn(businessId, 'drafts', { kind: 'event', name: 'test' });
};
const results = (): AgentToolResult[] => reported.filter((r): r is AgentToolResult => r !== null);
/** The first call's result (the later ones are the closing end_turn). */
const refusal = (reason: string) => expect(results()[0]).toMatchObject({ status: 'refused', reason });

const captions = (text = 'מבצע על זרי הסתיו: 20% הנחה עד יום חמישי'): ChannelCaptions => ({ instagram: { text, hashtags: ['#פרחים'] } });
const design = (overrides: Partial<DesignSpec> = {}, edit: Partial<DesignSpec['photos'][number]> = {}): DesignSpec => ({
  photos: [{ assetId: photoId, ...edit }],
  title: '20% הנחה על זרי הסתיו',
  ...overrides,
});
const plan = (overrides: Partial<PlannedPost> = {}): PlannedPost => ({
  topic: 'מבצע זרי סתיו',
  contentType: 'promotions',
  format: 'single',
  factIds: ['f1', 'f2'],
  mediaAssetIds: [],
  brief: 'פוסט על המבצע',
  ...overrides,
});
const END = call.endTurn();

async function asset(width: number) {
  const [row] = await db.withBusiness('messaging', businessId, (tx) =>
    tx.insert(schema.mediaAsset).values({ businessId, kind: 'photo', source: 'owner', storagePath: `p/${randomUUID()}.jpg`, mimeType: 'image/jpeg', width, height: Math.round(width * 0.75), sha256: randomUUID() }).returning({ id: schema.mediaAsset.id }),
  );
  return row!.id;
}

async function addPost(status: 'planned' | 'drafting' | 'awaiting_approval' | 'approved' | 'scheduled' | 'awaiting_clarification' | 'needs_review', overrides: { plan?: PlannedPost; version?: { captions: ChannelCaptions; design: DesignSpec }; position?: number } = {}) {
  const planned = overrides.plan ?? plan({ mediaAssetIds: [photoId] });
  const [row] = await db.withBusiness('workflow', businessId, (tx) =>
    tx.insert(schema.post).values({ businessId, weeklyUpdateId: weekId, position: overrides.position ?? 0, format: planned.format, plan: planned, status }).returning({ id: schema.post.id }),
  );
  if (overrides.version) {
    const v = overrides.version;
    // The content role writes versions, as the drafts flow does.
    const [version] = await db.withBusiness('content', businessId, (tx) =>
      tx
        .insert(schema.postVersion)
        .values({ businessId, postId: row!.id, versionNumber: 1, captions: v.captions, renderedMedia: {}, factSources: [], factCheckPassed: true, contentHash: randomUUID().replaceAll('-', '').padEnd(64, '0'), designSpec: v.design })
        .returning({ id: schema.postVersion.id }),
    );
    await db.withBusiness('workflow', businessId, (tx) => tx.update(schema.post).set({ currentVersionId: version!.id }).where(eq(schema.post.id, row!.id)));
  }
  return row!.id;
}

async function message(body: string, direction: 'inbound' | 'outbound' = 'inbound', at = new Date(), photos: string[] = []) {
  await db.withBusiness('messaging', businessId, (tx) =>
    tx.insert(schema.message).values({ businessId, direction, kind: 'text', provider: 'sim', providerMessageId: randomUUID(), fromPhone: approver, toPhone: '+972500000000', body, mediaAssetIds: photos, createdAt: at }),
  );
}

beforeEach(async () => {
  businessId = randomUUID();
  approver = `+9725${Math.floor(1e7 + Math.random() * 9e7)}`;
  weekId = randomUUID();
  sim = new ModelSimulator({ defaults: false });
  reported = [];
  created = [];
  changed = [];
  outcome = { status: 'ok', data: { postId: 'x' } };
  holiday = false;
  await db.withBusiness('workflow', businessId, async (tx) => {
    await tx.insert(schema.business).values({
      id: businessId,
      name: 'פרחי דנה',
      status: 'active',
      approverPhone: approver,
      profile: {
        name: 'פרחי דנה',
        approverPhone: approver,
        channels: ['instagram'],
        style: 'warm',
        formats: ['single', 'carousel'],
        postsPerWeek: 3,
        location: { city: 'רמת גן', address: 'ביאליק 40', hours: 'א׳-ו׳ 9:00-19:00', fulfillment: ['pickup'] },
        forbiddenTopics: ['פוליטיקה'],
      },
    });
    await tx.insert(schema.conversationState).values({ businessId, step: 'processing_update' });
  });
  photoId = await asset(2000);
  smallPhotoId = await asset(1000);
  await db.withBusiness('workflow', businessId, (tx) =>
    tx.insert(schema.weeklyUpdate).values({
      id: weekId,
      businessId,
      weekStart: new Date(Date.now() - 2 * DAY_MS).toISOString().slice(0, 10),
      status: 'planned',
      originalText: UPDATE,
      extractedFacts: {
        facts: [
          { id: 'f1', type: 'discount_percent', value: '20', sourceQuote: '20% הנחה' },
          { id: 'f2', type: 'date', value: 'עד יום חמישי', sourceQuote: 'עד יום חמישי' },
        ],
      },
      receivedAt: new Date(Date.now() - 60_000),
    }),
  );
  await message(UPDATE, 'inbound', new Date(Date.now() - 61_000));
});

afterEach(() => {
  const problems = sim.agentScriptProblems();
  expect(problems).toEqual([]);
});

describe('the drafts agent', () => {
  it('has the tools of its row, and is done once no post is planned or drafting', async () => {
    expect([...draftsAgent.tools].sort()).toEqual(['apply_change', 'ask_owner', 'create_draft', 'end_turn', 'hand_off_to_console', 'plan_posts', 'record_decline', 'request_photo'].sort());
    const post = await addPost('planned');
    const done = () => draftsAgent.isDone({ businessId, db, turnId: randomUUID() });
    expect(await done()).toBe(false);
    for (const status of ['drafting'] as const) {
      await db.withBusiness('workflow', businessId, (tx) => tx.update(schema.post).set({ status }).where(eq(schema.post.id, post)));
      expect(await done()).toBe(false);
    }
    for (const status of ['awaiting_approval', 'awaiting_clarification', 'needs_review', 'approved'] as const) {
      await db.withBusiness('workflow', businessId, (tx) => tx.update(schema.post).set({ status }).where(eq(schema.post.id, post)));
      expect(await done(), status).toBe(true);
    }
  });
});

describe('create_draft', () => {
  it('passes a checked draft to the workflow and reports its result', async () => {
    const postId = await addPost('planned');
    outcome = { status: 'ok', data: { postId, versionNumber: 1 } };
    await turn(step(call.createDraft({ postId, captions: captions(), usedFactIds: ['f1', 'f2'], design: design() })), step(END));
    expect(results()[0]).toEqual({ status: 'ok', data: { postId, versionNumber: 1 } });
    expect(created).toEqual([{ postId, captions: captions(), usedFactIds: ['f1', 'f2'], design: design() }]);
  });

  it('works from drafting and awaiting_clarification too', async () => {
    for (const status of ['drafting', 'awaiting_clarification'] as const) {
      const postId = await addPost(status, { position: status === 'drafting' ? 0 : 1 });
      await turn(step(call.createDraft({ postId, captions: captions(), usedFactIds: ['f1', 'f2'], design: design() })), step(END));
    }
    expect(created).toHaveLength(2);
  });

  it('refuses a post that is not this business’s, or that already has a draft, or is past drafting', async () => {
    const approved = await addPost('awaiting_approval', { version: { captions: captions(), design: design() } });
    // The only post has a draft already, so the done rule ends each turn after its first step.
    await turn(step(call.createDraft({ postId: randomUUID(), captions: captions(), usedFactIds: [], design: design() })));
    refusal('unknown_id');
    reported = [];
    sim = new ModelSimulator({ defaults: false });
    await turn(step(call.createDraft({ postId: approved, captions: captions(), usedFactIds: [], design: design() })));
    refusal('not_allowed');
    expect(created).toEqual([]);
  });

  it('refuses a caption detail with no source, naming it (the fact check)', async () => {
    const postId = await addPost('planned');
    await turn(step(call.createDraft({ postId, captions: captions('חלות ב-25 ₪'), usedFactIds: ['f1'], design: design() })), step(END));
    expect(results()[0]).toMatchObject({ status: 'refused', reason: 'fact_mismatch', detail: expect.stringMatching(/25/) });
    expect(created).toEqual([]);
  });

  it('refuses a title with a detail that has no source', async () => {
    const postId = await addPost('planned');
    await turn(step(call.createDraft({ postId, captions: captions(), usedFactIds: ['f1', 'f2'], design: design({ title: '30% הנחה' }) })), step(END));
    expect(results()[0]).toMatchObject({ status: 'refused', reason: 'fact_mismatch', detail: expect.stringMatching(/title/) });
  });

  it('checks the badge: a discount badge needs its fact, a malformed one is badge_invalid, a holiday needs a holiday', async () => {
    const postId = await addPost('planned');
    const withBadge = (badge: DesignSpec['badge']) => call.createDraft({ postId, captions: captions(), usedFactIds: ['f1', 'f2'], design: design({ badge }) });
    await turn(step(withBadge({ kind: 'discount', text: '-20%', factId: 'f1' })), step(END));
    expect(results()[0]).toMatchObject({ status: 'ok' });
    reported = [];
    sim = new ModelSimulator({ defaults: false });
    await turn(step(withBadge({ kind: 'discount', text: '-25%', factId: 'f1' })), step(END));
    refusal('fact_mismatch');
    reported = [];
    sim = new ModelSimulator({ defaults: false });
    await turn(step(withBadge({ kind: 'discount', text: '20%', factId: 'f1' })), step(END));
    refusal('badge_invalid');
    reported = [];
    sim = new ModelSimulator({ defaults: false });
    await turn(step(withBadge({ kind: 'holiday' })), step(END));
    refusal('fact_mismatch');
    holiday = true;
    reported = [];
    sim = new ModelSimulator({ defaults: false });
    await turn(step(withBadge({ kind: 'holiday' })), step(END));
    expect(results()[0]).toMatchObject({ status: 'ok' });
  });

  it('refuses a fact the plan does not name, a photo the plan does not name, and an unknown photo', async () => {
    const postId = await addPost('planned', { plan: plan({ factIds: ['f1'], mediaAssetIds: [photoId] }) });
    await turn(step(call.createDraft({ postId, captions: captions(), usedFactIds: ['f1', 'f2'], design: design() })), step(END));
    refusal('invalid_input');
    reported = [];
    sim = new ModelSimulator({ defaults: false });
    await turn(step(call.createDraft({ postId, captions: captions(), usedFactIds: ['f1'], design: design({ photos: [{ assetId: smallPhotoId }] }) })), step(END));
    refusal('invalid_input');
    reported = [];
    sim = new ModelSimulator({ defaults: false });
    await turn(step(call.createDraft({ postId, captions: captions(), usedFactIds: ['f1'], design: design({ photos: [{ assetId: randomUUID() }] }) })), step(END));
    refusal('unknown_id');
  });

  it('refuses a crop that keeps fewer than 720 source pixels across (edit_out_of_range), and passes a wide one', async () => {
    const postId = await addPost('planned', { plan: plan({ mediaAssetIds: [photoId] }) });
    await turn(step(call.createDraft({ postId, captions: captions(), usedFactIds: ['f1', 'f2'], design: design({}, { crop: { x: 0, y: 0, w: 0.3, h: 1 } }) })), step(END));
    refusal('edit_out_of_range');
    reported = [];
    sim = new ModelSimulator({ defaults: false });
    await turn(step(call.createDraft({ postId, captions: captions(), usedFactIds: ['f1', 'f2'], design: design({}, { crop: { x: 0.1, y: 0, w: 0.5, h: 1 }, rotateDeg: 2, brightness: 0.1 }) })), step(END));
    expect(results()[0]).toMatchObject({ status: 'ok' });
  });

  it('refuses a post that mentions a topic the owner asked to avoid', async () => {
    const postId = await addPost('planned');
    await turn(step(call.createDraft({ postId, captions: captions('פוליטיקה ופרחים'), usedFactIds: [], design: design() })), step(END));
    refusal('forbidden_content');
  });

  it('refuses captions that miss a channel, or name one the business does not have', async () => {
    const postId = await addPost('planned');
    await turn(step(call.createDraft({ postId, captions: { facebook: { text: 'שלום', hashtags: [] } }, usedFactIds: [], design: design() })), step(END));
    refusal('invalid_input');
  });

  it('passes the workflow’s refusal on, such as a render that failed', async () => {
    const postId = await addPost('planned');
    outcome = { status: 'refused', reason: 'render_failed', detail: 'the title does not fit in two lines' };
    await turn(step(call.createDraft({ postId, captions: captions(), usedFactIds: ['f1', 'f2'], design: design() })), step(END));
    expect(results()[0]).toEqual({ status: 'refused', reason: 'render_failed', detail: 'the title does not fit in two lines' });
  });
});

// A fix leaves the post waiting for the owner, so the done rule ends the turn after the first step.
describe('apply_change', () => {
  const current = () => ({ captions: captions(), design: design() });
  const ASK = 'מושלם, רק תוסיפי שיש משלוחים';

  async function withVersion(status: 'awaiting_approval' | 'approved' | 'scheduled' = 'awaiting_approval') {
    const postId = await addPost(status, { version: current() });
    await message('הנה הטיוטה', 'outbound', new Date(Date.now() - 5_000));
    await message(ASK, 'inbound', new Date(Date.now() - 1_000));
    return postId;
  }

  it('passes a fix to the workflow: the new captions, the quote, and the rule', async () => {
    const postId = await withVersion('approved');
    const next = captions('מבצע על זרי הסתיו: 20% הנחה עד יום חמישי. יש משלוחים');
    await turn(step(call.applyChange({ postId, ownerQuote: 'רק תוסיפי שיש משלוחים', captions: next, rule: { text: 'לציין משלוחים', scope: 'caption' } })));
    expect(results()[0]).toMatchObject({ status: 'ok' });
    expect(changed).toEqual([{ postId, ownerQuote: 'רק תוסיפי שיש משלוחים', captions: next, rule: { text: 'לציין משלוחים', scope: 'caption' } }]);
  });

  it('refuses a quote that is not in the owner’s latest message', async () => {
    const postId = await withVersion();
    await turn(step(call.applyChange({ postId, ownerQuote: 'תשני הכול', captions: captions('אחר') })));
    refusal('quote_not_found');
    expect(changed).toEqual([]);
  });

  it('refuses a post that is still being drafted, and a change that changes nothing', async () => {
    const drafting = await addPost('drafting', { position: 1 });
    const postId = await withVersion();
    // The post still being drafted keeps the turn open, so each turn closes with end_turn.
    await turn(step(call.applyChange({ postId: drafting, ownerQuote: 'רק תוסיפי שיש משלוחים', captions: captions('אחר') })), step(END));
    refusal('not_allowed');
    reported = [];
    sim = new ModelSimulator({ defaults: false });
    await turn(step(call.applyChange({ postId, ownerQuote: 'רק תוסיפי שיש משלוחים', captions: captions(), design: design() })), step(END));
    refusal('no_change');
  });

  it('runs the same fact check on the new content', async () => {
    const postId = await withVersion();
    await turn(step(call.applyChange({ postId, ownerQuote: 'רק תוסיפי שיש משלוחים', captions: captions('משלוחים ב-30 ₪') })));
    refusal('fact_mismatch');
    expect(changed).toEqual([]);
  });

  it('may narrow the networks, never widen them', async () => {
    const postId = await withVersion();
    await turn(step(call.applyChange({ postId, ownerQuote: 'רק תוסיפי שיש משלוחים', networks: ['facebook'] })));
    refusal('invalid_input');
  });
});

describe('the context (agent.md, Context)', () => {
  async function built(input: Partial<Parameters<typeof buildContext>[1]> = {}): Promise<AgentContext> {
    const { context } = await db.withBusiness('workflow', businessId, (tx) =>
      buildContext(tx, { businessId, agent: draftsAgent, now: new Date(), history: [], budget: { stepsLeft: 12, costLeftUsd: 0.06 }, toolResults: [], ...input }),
    );
    return context;
  }

  it('carries the active preference rules, oldest first, and not an inactive one', async () => {
    await db.withBusiness('business_data', businessId, async (tx) => {
      await tx.insert(schema.preferenceRule).values([
        { businessId, scope: 'caption', rule: 'בלי אימוג׳ים', createdAt: new Date(Date.now() - 2000) },
        { businessId, scope: 'design', rule: 'כותרת קצרה', createdAt: new Date(Date.now() - 1000) },
        { businessId, scope: 'general', rule: 'כלל ישן', active: false },
      ]);
    });
    expect((await built()).rules).toEqual(['בלי אימוג׳ים', 'כותרת קצרה']);
  });

  it('carries each post’s current captions and design spec', async () => {
    const withVersion = await addPost('awaiting_approval', { version: { captions: captions(), design: design({ badge: { kind: 'new' } }) } });
    const bare = await addPost('planned', { position: 1 });
    const posts = (await built()).posts;
    expect(posts.find((p) => p.id === withVersion)).toMatchObject({ captions: captions(), design: design({ badge: { kind: 'new' } }) });
    expect(posts.find((p) => p.id === bare)?.captions).toBeUndefined();
  });

  it('carries the image_review notes of the photos in messages and in posts, and reads none for an unreviewed one', async () => {
    await db.withBusiness('workflow', businessId, (tx) =>
      tx
        .update(schema.mediaAsset)
        .set({ review: { usable: true, score: 0.9, issues: [], description: 'זר סתיו על שולחן', crop: { x: 0.1, y: 0.1, w: 0.7, h: 0.8 }, rotateDeg: -2, brightness: 0.1 } })
        .where(eq(schema.mediaAsset.id, photoId)),
    );
    const postId = await addPost('planned', { plan: plan({ mediaAssetIds: [photoId, smallPhotoId] }) });
    await message('הנה תמונה', 'inbound', new Date(), [photoId]);
    const context = await built();
    const notes = { assetId: photoId, usable: true, description: 'זר סתיו על שולחן', suggested: { crop: { x: 0.1, y: 0.1, w: 0.7, h: 0.8 }, rotateDeg: -2, brightness: 0.1 } };
    expect(context.posts.find((p) => p.id === postId)?.photos).toEqual([notes, { assetId: smallPhotoId }]);
    expect(context.messages.at(-1)?.photos).toEqual([notes]);
  });
});
