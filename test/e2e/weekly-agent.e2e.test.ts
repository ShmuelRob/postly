/**
 * The weekly-update agent (WP-93; agent.md: Agents, record_fact, plan_posts, How it fits the state
 * machines). With the weekly flow switched to the agent for one business, an owner's update runs
 * the weekly agent on the scripted agent (no real model): it records the facts one by one, asks
 * about the missing end date, records the answer, asks for a photo, and plans the week. A plan with
 * the wrong number of posts is refused; the corrected plan is stored (FACTS_EXTRACTED) and drafting
 * sends one draft per post. Everything else is real: messaging, the workflow, the agent runtime and
 * its code checks, the model layer, and the database; the vendors are the simulators.
 */
import { eq } from 'drizzle-orm';
import { afterAll, expect, inject } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AgentContext } from '../../src/contracts/agent.js';
import { BusinessProfile } from '../../src/contracts/business-profile.js';
import type { PlannedPost } from '../../src/contracts/content.js';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { handOffLine } from '../../src/modules/agent/index.js';
import { weeklyCopy as copy } from '../../src/modules/workflow/index.js';
import { MessagingSimulator, ModelSimulator, PaymentSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { call, step, stepFrom } from '../../src/simulators/scripted-agent.js';
import { e2eTest, placeholderPng, type AppFactory, type E2eHarness, type Providers } from './harness/index.js';

const BUSINESS_PHONE = '+972521111193';
const OWNER = '+972501230093';
const MEDIA_ORIGIN = 'https://media.postly.test/';

const UPDATE = 'השבוע 20% הנחה על כל זרי הסתיו';
const QUESTION = 'עד מתי בתוקף ה-20% הנחה על זרי הסתיו?';
const ANSWER = 'עד יום חמישי';
const PHOTO_REQUEST = 'יש לך תמונה של זר סתיו? איתה הפוסט על המבצע ייראה הכי טוב';

const db = createDatabase(inject('databaseUrls'), { max: 3 });
afterAll(() => db.close());

function memoryStorage() {
  const files = new Map<string, { mimeType: string; data: Uint8Array }>();
  return {
    async put(path: string, data: Uint8Array, mimeType: string) {
      files.set(path, { mimeType, data });
    },
    urlFor: (path: string) => MEDIA_ORIGIN + path,
    read: async (ref: string) => files.get(ref.startsWith(MEDIA_ORIGIN) ? ref.slice(MEDIA_ORIGIN.length) : ref),
  };
}

/** One placeholder image per network, so drafting can follow the plan without Chromium. */
function fakeRenderer(storage: ReturnType<typeof memoryStorage>) {
  let n = 0;
  return {
    async render(request: { networks: ('instagram' | 'facebook')[] }) {
      const out: Record<string, { storagePath: string; width: number; height: number; mimeType: 'image/png' }[]> = {};
      for (const network of request.networks) {
        const storagePath = `renders/${Date.now()}-${n++}.png`;
        await storage.put(storagePath, placeholderPng(1080, 1080, [245, 225, 200], [150, 80, 40]), 'image/png');
        out[network] = [{ storagePath, width: 1080, height: 1080, mimeType: 'image/png' }];
      }
      return out;
    },
  };
}

const at = (local: string) => new Date(`${local}+02:00`);

const planned = (topic: string, overrides: Partial<PlannedPost> = {}): PlannedPost => ({
  topic,
  contentType: 'promotions',
  format: 'single',
  factIds: [],
  mediaAssetIds: [],
  brief: topic,
  ...overrides,
});

/** The photos the owner sent, from the context the runtime built (their ids are not known in advance). */
const photosIn = (context: AgentContext) => context.messages.flatMap((m) => m.photos.map((p) => p.assetId));

type E2e = E2eHarness;

/** The app on the simulators, and an active florist whose weekly flow runs on the agent. */
async function start(e2e: E2e, owner: string) {
  const clock = { now: at('2026-11-01T14:00:00') };
  const now = () => clock.now;
  const storage = memoryStorage();
  const messagingSim = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const model = new ModelSimulator();
  const providers = { messaging: messagingSim, publishing: new PublishingSimulator(), model, payment: new PaymentSimulator(), renderer: { render: async () => ({}) } } satisfies Providers;
  const ref: { postly?: ReturnType<typeof createApp> } = {};
  const app: AppFactory = ({ messaging, publishing, model: recorded }) => {
    ref.postly = createApp({
      db,
      providers: { messaging, publishing, models: { google: recorded } },
      design: { forBusiness: () => fakeRenderer(storage) },
      media: storage,
      businessNumber: BUSINESS_PHONE,
      samplePhotoUrl: storage.urlFor('none'),
      now,
    });
    return {
      async deliverInbound(message) {
        await ref.postly!.messaging.receive(message);
        await ref.postly!.messaging.flushBursts();
      },
    };
  };
  const run = await e2e.start({ providers, app, ownerPhone: owner, businessPhone: BUSINESS_PHONE, readMedia: storage.read, now });
  const postly = ref.postly!;

  // An active florist, with the weekly flow switched to the agent for this business only.
  await db.withSystem('console', (tx) => tx.update(schema.business).set({ approverPhone: `+9724${Date.now()}` }).where(eq(schema.business.approverPhone, owner)));
  const businessId = await postly.onboarding.createBusiness({ approverPhone: owner, name: 'פרחי דנה' });
  const profile = BusinessProfile.parse({
    name: 'פרחי דנה',
    field: 'חנות פרחים',
    mainProducts: ['זרי פרחים', 'עציצים'],
    location: { city: 'רמת גן', address: 'ביאליק 40', hours: 'א׳-ו׳ 9:00-19:00', fulfillment: ['pickup', 'delivery'] },
    differentiator: 'פרחים טריים מהמגדל בכל בוקר',
    channels: ['instagram'],
    style: 'warm',
    postsPerWeek: 3,
    approverPhone: owner,
  });
  await db.withSystem('console', async (tx) => {
    await tx.update(schema.business).set({ status: 'active', profile, style: 'warm', agentFlows: { weekly: true } }).where(eq(schema.business.id, businessId));
    await tx.update(schema.conversationState).set({ step: 'idle' }).where(eq(schema.conversationState.businessId, businessId));
  });
  return { run, postly, model, messagingSim, businessId, clock };
}

e2eTest('the weekly agent asks for the missing end date and a photo, refuses a plan with the wrong count, and stores the week', { timeout: 90_000 }, async ({ e2e }) => {
  const { run, model, messagingSim, businessId, clock } = await start(e2e, OWNER);

  model.script('intent_detection', { intent: 'weekly_update', confidence: 0.93 });
  model.scriptAgent(
    'weekly',
    // Turn 1, on the update: the discount is a fact; the end date is missing, so one question.
    [
      step(call.recordFact({ type: 'discount_percent', value: '20', sourceQuote: '20% הנחה' }), call.recordFact({ type: 'product', value: 'זרי סתיו', sourceQuote: 'זרי הסתיו' })),
      step(call.askOwner(QUESTION, { topic: 'detail:date' })),
    ],
    // Turn 2, on the answer: the end date is a fact; there is no photo, so the agent asks for one.
    [step(call.recordFact({ type: 'date', value: 'יום חמישי', sourceQuote: ANSWER })), step(call.requestPhoto('week', PHOTO_REQUEST))],
    // Turn 3, on the photo: a plan of two posts is refused (the profile has three a week), then three.
    [
      stepFrom((ctx) => ({
        calls: [call.planPosts({ mode: 'initial', posts: [planned('מבצע זרי סתיו', { factIds: ['f1', 'f2', 'f3'], mediaAssetIds: photosIn(ctx) }), planned('טיפ לזר שמחזיק שבוע', { contentType: 'tips' })] })],
        confidence: 0.85,
      })),
      stepFrom((ctx) => ({
        calls: [
          call.planPosts({
            mode: 'initial',
            posts: [
              planned('מבצע זרי סתיו', { factIds: ['f1', 'f2', 'f3'], mediaAssetIds: photosIn(ctx), brief: '20% הנחה על זרי הסתיו עד יום חמישי' }),
              planned('טיפ לזר שמחזיק שבוע', { contentType: 'tips', brief: 'איך שומרים על זר טרי' }),
              planned('פרחים טריים מהמגדל', { contentType: 'behind_the_scenes', brief: 'פרחים טריים מהמגדל בכל בוקר' }),
            ],
          }),
        ],
        confidence: 0.9,
      })),
    ],
  );

  // 1. The update: the agent's question reaches the owner; the conversation waits for the answer.
  await run.owner.sendsText(UPDATE);
  expect(run.owner.received().map((m) => m.text)).toEqual([QUESTION]);
  const state = async () => (await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.conversationState)))[0]!;
  expect((await state()).step).toBe('awaiting_answer');
  expect((await state()).openQuestion).toMatchObject({ key: 'detail:date', attempts: 1 });

  // 2. The answer becomes a fact; the agent asks for a photo.
  clock.now = at('2026-11-01T14:05:00');
  await run.owner.sendsText(ANSWER);
  expect(run.owner.received().map((m) => m.text)).toEqual([QUESTION, PHOTO_REQUEST]);
  expect((await state()).openQuestion).toMatchObject({ key: 'photo_request:week' });

  // 3. The photo: the plan with the wrong count is refused, the corrected one is stored, and drafting follows.
  clock.now = at('2026-11-01T14:09:00');
  await run.owner.sendsImage(messagingSim.addMedia('image/png', placeholderPng(1080, 1080, [230, 160, 90], [120, 60, 20])));
  const received = run.owner.received();
  expect(received.slice(0, 3).map((m) => m.text)).toEqual([QUESTION, PHOTO_REQUEST, copy.updateReceived(3)]);
  expect(received.slice(3).map((m) => m.kind)).toEqual(['buttons', 'buttons', 'buttons']);

  const [week] = await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.weeklyUpdate));
  expect(week).toMatchObject({ status: 'planned', originalText: UPDATE });
  expect(week!.mediaAssetIds).toHaveLength(1);
  expect(week!.extractedFacts).toEqual({
    facts: [
      { id: 'f1', type: 'discount_percent', value: '20', sourceQuote: '20% הנחה' },
      { id: 'f2', type: 'product', value: 'זרי סתיו', sourceQuote: 'זרי הסתיו' },
      { id: 'f3', type: 'date', value: 'יום חמישי', sourceQuote: ANSWER },
    ],
    missingDetails: [],
  });
  const posts = await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.post).orderBy(schema.post.position));
  expect(posts.map((p) => [(p.plan as PlannedPost).topic, p.status])).toEqual([
    ['מבצע זרי סתיו', 'awaiting_approval'],
    ['טיפ לזר שמחזיק שבוע', 'awaiting_approval'],
    ['פרחים טריים מהמגדל', 'awaiting_approval'],
  ]);
  expect((posts[0]!.plan as PlannedPost).mediaAssetIds).toEqual(week!.mediaAssetIds);
  expect((await state()).step).toBe('reviewing_drafts');

  // What the agent did, step by step (the report's "Agent steps" section shows the same).
  const results = model.agentSteps.map((s) => [s.turn, s.step, s.calls?.map((c) => c.tool).join('+'), s.results.map((r) => (r.result.status === 'refused' ? r.result.reason : 'ok')).join('+')]);
  expect(results).toEqual([
    [1, 1, 'record_fact+record_fact', 'ok+ok'],
    [1, 2, 'ask_owner', ''],
    [2, 1, 'record_fact', 'ok'],
    [2, 2, 'request_photo', ''],
    [3, 1, 'plan_posts', 'plan_invalid'],
    [3, 2, 'plan_posts', ''],
  ]);
  expect(run.networkPosts()).toEqual([]);
});

e2eTest('a hand-off before the plan sends the week to review (EXTRACTION_FAILED) and the owner hears a person will continue', { timeout: 90_000 }, async ({ e2e }) => {
  const owner = '+972501230094';
  const { run, model, businessId } = await start(e2e, owner);
  model.script('intent_detection', { intent: 'weekly_update', confidence: 0.9 });
  model.scriptAgent('weekly', [step(call.handOff('sensitive', 'The owner mentions a family loss; a person should answer.'))]);

  await run.owner.sendsText('השבוע החנות סגורה, היה לנו אבל במשפחה');

  const [week] = await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.weeklyUpdate));
  expect(week).toMatchObject({ status: 'needs_review' });
  expect(run.owner.received().map((m) => m.text)).toEqual([handOffLine('פוסטלי', 'he')]);
  const items = await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.consoleItem));
  expect(items.map((i) => [i.kind, (i.details as { reason?: string }).reason])).toEqual([['handoff', 'sensitive']]);
  const [state] = await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.conversationState));
  expect(state!.handoffAt).not.toBeNull();
  expect(await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.post))).toEqual([]);
});
