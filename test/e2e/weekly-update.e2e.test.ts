/**
 * Weekly update (WP-31, PRD "Weekly update and content preparation" and "A week without an update";
 * technical-design.md, Weekly update flow). An active business gets its week row on Sunday; the
 * owner sends an update by text, voice, and photo, and the facts and the week's plan are stored. A
 * week without an update gets the reminder template on Monday and is skipped at the Thursday
 * cutoff; an update after the cutoff counts for next week. Everything is real (messaging, the
 * workflow, the model layer with its seeded prompts and code checks, and the database) except the
 * vendors, which are the simulators. The copy is provisional (H6).
 */
import { eq } from 'drizzle-orm';
import { afterAll, expect, inject } from 'vitest';
import { createApp } from '../../src/app.js';
import { BusinessProfile } from '../../src/contracts/business-profile.js';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { weeklyCopy as copy } from '../../src/modules/workflow/index.js';
import { MessagingSimulator, ModelSimulator, PaymentSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { e2eTest, placeholderPng, type AppFactory, type Providers } from './harness/index.js';

const BUSINESS_PHONE = '+972521111131';
const MEDIA_ORIGIN = 'https://media.postly.test/';

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

/** Local Jerusalem time (UTC+2 in November) as a Date. */
const at = (local: string) => new Date(`${local}+02:00`);

/** A test clock the app, messaging, and the report all read. */
function clock(start: string) {
  let current = at(start);
  return { now: () => current, set: (local: string) => (current = at(local)) };
}

/** An active business after onboarding, with the conversation idle (the end state WP-30 tests). */
async function activeBusiness(postly: ReturnType<typeof createApp>, owner: string): Promise<string> {
  // approver_phone is unique: free the fixture number from an earlier run first.
  await db.withSystem('console', (tx) =>
    tx.update(schema.business).set({ approverPhone: `+9724${Date.now()}` }).where(eq(schema.business.approverPhone, owner)),
  );
  const businessId = await postly.onboarding.createBusiness({ approverPhone: owner, name: 'מאפיית בן עמי' });
  const profile = BusinessProfile.parse({
    name: 'מאפיית בן עמי',
    field: 'מאפייה שכונתית',
    mainProducts: ['חלות', 'בורקס', 'עוגות שמרים'],
    location: { city: 'חולון', address: 'רחוב הרצל 12', hours: 'א׳-ה׳ 7:00-19:00, שישי 7:00-13:00', fulfillment: ['pickup'] },
    differentiator: 'בצק שתופח 24 שעות',
    channels: ['instagram', 'facebook'],
    style: 'warm',
    postsPerWeek: 3,
    approverPhone: owner,
  });
  await db.withSystem('console', async (tx) => {
    await tx.update(schema.business).set({ status: 'active', profile, style: 'warm' }).where(eq(schema.business.id, businessId));
    await tx.update(schema.conversationState).set({ step: 'idle' }).where(eq(schema.conversationState.businessId, businessId));
  });
  return businessId;
}

const weeks = (businessId: string) =>
  db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.weeklyUpdate).orderBy(schema.weeklyUpdate.weekStart));
const posts = (businessId: string) => db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.post).orderBy(schema.post.position));
const step = async (businessId: string) =>
  (await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.conversationState)))[0]?.step;

/** Stores one placeholder image per network, so drafting (WP-32) can follow the plan without Chromium. */
function fakeRenderer(storage: ReturnType<typeof memoryStorage>) {
  let n = 0;
  return {
    async render(request: { networks: ('instagram' | 'facebook')[] }) {
      const out: Record<string, { storagePath: string; width: number; height: number; mimeType: 'image/png' }[]> = {};
      for (const network of request.networks) {
        const storagePath = `renders/${Date.now()}-${n++}.png`;
        await storage.put(storagePath, placeholderPng(1080, 1080, [250, 240, 230], [120, 60, 30]), 'image/png');
        out[network] = [{ storagePath, width: 1080, height: 1080, mimeType: 'image/png' }];
      }
      return out;
    },
  };
}

function setup(time: ReturnType<typeof clock>) {
  const storage = memoryStorage();
  const messagingSim = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const modelSim = new ModelSimulator();
  const providers = {
    messaging: messagingSim,
    publishing: new PublishingSimulator(),
    model: modelSim,
    payment: new PaymentSimulator(),
    renderer: { render: async () => ({}) },
  } satisfies Providers;
  const ref: { postly?: ReturnType<typeof createApp> } = {};
  /** Off while the owner sends several messages that form one burst. */
  let flushEach = true;
  const app: AppFactory = ({ messaging, publishing, model }) => {
    ref.postly = createApp({
      db,
      // This test drives the one-shot flows (agent.md, A9), which only tests compose.
      oneShotFlows: true,
      providers: { messaging, publishing, models: { google: model } },
      design: { forBusiness: () => fakeRenderer(storage) },
      media: storage,
      businessNumber: BUSINESS_PHONE,
      samplePhotoUrl: storage.urlFor('none'),
      now: time.now,
    });
    return {
      async deliverInbound(message) {
        await ref.postly!.messaging.receive(message);
        if (flushEach) await ref.postly!.messaging.flushBursts();
      },
    };
  };
  const burst = async (send: () => Promise<void>) => {
    flushEach = false;
    await send();
    flushEach = true;
    await ref.postly!.messaging.flushBursts();
  };
  return { storage, messagingSim, modelSim, providers, app, ref, burst };
}

const UPDATE_TEXT = 'השבוע מבצע על חלות: 2 ב-25 ₪ עד יום שישי';
const UPDATE_VOICE = 'וגם הגיעו עוגות שמרים חדשות עם שוקולד, הלקוחות מאוד אוהבים אותן';

e2eTest('an update by text, voice, and photo comes in and the week plan is stored', { timeout: 60_000 }, async ({ e2e }) => {
  const owner = '+972501230040';
  const time = clock('2026-11-01T08:00:00');
  const { storage, messagingSim, modelSim, providers, app, ref, burst } = setup(time);
  const run = await e2e.start({ providers, app, ownerPhone: owner, businessPhone: BUSINESS_PHONE, readMedia: storage.read, now: time.now });
  const postly = ref.postly!;
  const businessId = await activeBusiness(postly, owner);

  // Sunday morning: the week row exists before any message; no reminder yet.
  await postly.weekly.tickBusiness(businessId, time.now());
  expect((await weeks(businessId)).map((w) => [w.weekStart, w.status])).toEqual([['2026-11-01', 'awaiting']]);

  // Sunday afternoon: one burst with a text, a voice note, and a photo.
  time.set('2026-11-01T14:00:00');
  const voice = messagingSim.addMedia('audio/ogg', new Uint8Array([1, 2, 3]));
  const photo = messagingSim.addMedia('image/png', placeholderPng(1080, 1080, [240, 220, 190], [140, 70, 30]));
  modelSim.scriptTranscription({ text: UPDATE_VOICE, language: 'he' });
  // The first extraction paraphrases the price; the verbatim quote check rejects it and the model retries.
  const facts = [
    { id: 'f1', type: 'promotion', value: 'מבצע על חלות', sourceQuote: 'מבצע על חלות' },
    { id: 'f2', type: 'price', value: '2 חלות ב-25 ₪', sourceQuote: '2 ב-25 ₪' },
    { id: 'f3', type: 'date', value: 'עד יום שישי', sourceQuote: 'עד יום שישי' },
    { id: 'f4', type: 'product', value: 'עוגות שמרים עם שוקולד', sourceQuote: 'עוגות שמרים חדשות עם שוקולד' },
  ] as const;
  modelSim.script(
    'fact_extraction',
    { facts: [{ id: 'f1', type: 'price', value: '2 חלות ב-25 ₪', sourceQuote: 'שתי חלות ב-25 שקל' }], missingDetails: [] },
    { facts: [...facts], missingDetails: [] },
  );
  modelSim.script('weekly_planning', (input) => ({
    posts: [
      { topic: 'מבצע חלות', contentType: 'promotions', format: 'single', factIds: ['f1', 'f2', 'f3'], mediaAssetIds: [...input.mediaAssetIds], brief: 'המבצע על החלות עד שישי' },
      { topic: 'עוגות שמרים חדשות', contentType: 'products', format: 'single', factIds: ['f4'], mediaAssetIds: [], brief: 'העוגות החדשות עם שוקולד' },
      { topic: 'הבצק שלנו', contentType: 'behind_the_scenes', format: 'single', factIds: [], mediaAssetIds: [], brief: 'בצק שתופח 24 שעות' },
    ],
  }));
  await burst(async () => {
    await run.owner.sendsText(UPDATE_TEXT);
    await run.owner.sendsVoice(voice);
    await run.owner.sendsImage(photo);
  });

  // The owner hears back first; the update, the facts, and three planned posts are stored. Drafting
  // (WP-32, its own e2e) then sends one draft per post.
  expect(run.owner.received()[0]?.text).toBe(copy.updateReceived(3));
  expect(run.owner.received().slice(1).map((m) => m.kind)).toEqual(['buttons', 'buttons', 'buttons']);
  const [week] = await weeks(businessId);
  expect(week).toMatchObject({ weekStart: '2026-11-01', status: 'planned', originalText: UPDATE_TEXT, transcript: UPDATE_VOICE });
  expect(week?.mediaAssetIds).toHaveLength(1);
  expect(week?.receivedAt).toEqual(time.now());
  expect(week?.extractedFacts).toEqual({ facts, missingDetails: [] });
  const planned = await posts(businessId);
  expect(planned.map((p) => [p.position, p.status, p.format, p.weeklyUpdateId])).toEqual([
    [0, 'awaiting_approval', 'single', week?.id],
    [1, 'awaiting_approval', 'single', week?.id],
    [2, 'awaiting_approval', 'single', week?.id],
  ]);
  expect(planned[0]?.plan).toMatchObject({ topic: 'מבצע חלות', factIds: ['f1', 'f2', 'f3'], mediaAssetIds: week?.mediaAssetIds });
  expect(await step(businessId)).toBe('reviewing_drafts');

  // The quote check counted as a failed attempt in the model layer.
  const runs = await db.withBusiness('model', businessId, (tx) =>
    tx.select().from(schema.modelRun).where(eq(schema.modelRun.task, 'fact_extraction')).orderBy(schema.modelRun.attempt),
  );
  expect(runs.map((r) => [r.attempt, r.valid, r.error?.split(':')[0]])).toEqual([
    [1, false, 'code check'],
    [2, true, undefined],
  ]);
  expect(run.modelCalls().map((c) => c.task)).toEqual([
    'transcription',
    'fact_extraction',
    'fact_extraction',
    'weekly_planning',
    'caption_writing',
    'caption_writing',
    'caption_writing',
  ]);
  expect(run.networkPosts()).toEqual([]);
});

e2eTest('a week without an update gets the reminder template, then is skipped', { timeout: 60_000 }, async ({ e2e }) => {
  const owner = '+972501230041';
  const time = clock('2026-11-01T00:30:00');
  const { storage, providers, app, ref } = setup(time);
  const run = await e2e.start({ providers, app, ownerPhone: owner, businessPhone: BUSINESS_PHONE, readMedia: storage.read, now: time.now });
  const postly = ref.postly!;
  const businessId = await activeBusiness(postly, owner);
  const tick = async (local: string) => {
    time.set(local);
    await postly.weekly.tickBusiness(businessId, time.now());
  };
  const status = async () => (await weeks(businessId)).map((w) => [w.weekStart, w.status]);

  await tick('2026-11-01T00:30:00');
  expect(await status()).toEqual([['2026-11-01', 'awaiting']]);

  // Monday before 10:00: nothing yet. At 10:00: the reminder, once, with an approved template.
  await tick('2026-11-02T09:59:00');
  expect(run.owner.received()).toEqual([]);
  await tick('2026-11-02T10:00:00');
  await tick('2026-11-02T11:00:00');
  expect(run.owner.received().map((m) => [m.kind, m.template])).toEqual([
    ['template', { name: copy.REMINDER_TEMPLATE, language: 'he', variables: { businessName: 'מאפיית בן עמי' } }],
  ]);
  const [reminded] = await weeks(businessId);
  expect(reminded).toMatchObject({ status: 'reminded', reminderSentAt: at('2026-11-02T10:00:00') });

  // Thursday before noon the week is still open; at the cutoff it is skipped, with no posts.
  await tick('2026-11-05T11:59:00');
  expect(await status()).toEqual([['2026-11-01', 'reminded']]);
  await tick('2026-11-05T12:00:00');
  expect(await status()).toEqual([['2026-11-01', 'skipped']]);
  expect(await posts(businessId)).toEqual([]);
  expect(run.owner.received()).toHaveLength(1);
  expect(run.networkPosts()).toEqual([]);
});

e2eTest('an update after the cutoff counts for next week', { timeout: 60_000 }, async ({ e2e }) => {
  const owner = '+972501230042';
  const time = clock('2026-11-02T10:00:00');
  const { storage, modelSim, providers, app, ref } = setup(time);
  const run = await e2e.start({ providers, app, ownerPhone: owner, businessPhone: BUSINESS_PHONE, readMedia: storage.read, now: time.now });
  const postly = ref.postly!;
  const businessId = await activeBusiness(postly, owner);
  await postly.weekly.tickBusiness(businessId, time.now());
  time.set('2026-11-05T12:00:00');
  await postly.weekly.tickBusiness(businessId, time.now());

  // Friday: a text update after the week was skipped.
  time.set('2026-11-06T09:00:00');
  modelSim.script('intent_detection', { intent: 'weekly_update', confidence: 0.92 });
  // A plan whose briefs name no number without a source, so every draft passes the fact check.
  modelSim.script('weekly_planning', (input) => ({
    posts: [
      { topic: 'מבצע חלות', contentType: 'promotions', format: 'single', factIds: input.facts.map((f) => f.id), mediaAssetIds: [], brief: 'המבצע על החלות' },
      { topic: 'עוגות שמרים חדשות', contentType: 'products', format: 'single', factIds: [], mediaAssetIds: [], brief: 'העוגות החדשות עם שוקולד' },
      { topic: 'הבצק שלנו', contentType: 'behind_the_scenes', format: 'single', factIds: [], mediaAssetIds: [], brief: 'הבצק שלנו תופח לאט' },
    ],
  }));
  await run.owner.sendsText(UPDATE_TEXT);

  // The reminder, the reply that it counts for next week, then one draft per planned post, as in the first case.
  const received = run.owner.received();
  expect(received.slice(0, 2).map((m) => m.text ?? m.kind)).toEqual(['template', copy.updateForNextWeek(3)]);
  expect(received.slice(2).map((m) => m.kind)).toEqual(['buttons', 'buttons', 'buttons']);
  const all = await weeks(businessId);
  expect(all.map((w) => [w.weekStart, w.status, w.originalText])).toEqual([
    ['2026-11-01', 'skipped', null],
    ['2026-11-08', 'planned', UPDATE_TEXT],
  ]);
  const next = all[1];
  expect((await posts(businessId)).map((p) => [p.position, p.status, p.format, p.weeklyUpdateId])).toEqual([
    [0, 'awaiting_approval', 'single', next?.id],
    [1, 'awaiting_approval', 'single', next?.id],
    [2, 'awaiting_approval', 'single', next?.id],
  ]);

  // Sunday's tick keeps the early row as it is.
  time.set('2026-11-08T00:30:00');
  await postly.weekly.tickBusiness(businessId, time.now());
  expect((await weeks(businessId)).map((w) => [w.weekStart, w.status])).toEqual([
    ['2026-11-01', 'skipped'],
    ['2026-11-08', 'planned'],
  ]);
});
