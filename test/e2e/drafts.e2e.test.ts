/**
 * Drafts (WP-32, PRD "Weekly update and content preparation" and "Content safeguards";
 * technical-design.md, Drafts flow). After the weekly plan is stored, every post is written,
 * fact-checked in code, rendered by the real design engine, stored as a hashed version, and sent with
 * Approve and Change buttons. A caption whose price does not match the owner's is never sent. A
 * change request creates a new version and saves a preference rule. A single post with several
 * photos waits for the owner's choice. Everything is real except the vendors (simulators). Approval
 * itself is WP-33. The copy is provisional (H6).
 */
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, expect, inject } from 'vitest';
import { createApp } from '../../src/app.js';
import { BusinessProfile } from '../../src/contracts/business-profile.js';
import type { ModelTaskInput } from '../../src/contracts/model-tasks.js';
import { decodeButtonId } from '../../src/contracts/providers/messaging.js';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { createDesignRenderer } from '../../src/modules/design/index.js';
import { draftsCopy, weeklyCopy } from '../../src/modules/workflow/index.js';
import { MessagingSimulator, ModelSimulator, PaymentSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { e2eTest, type AppFactory, type Providers } from './harness/index.js';

const BUSINESS_PHONE = '+972521111132';
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

const svgPhoto = async (file: string) =>
  new Uint8Array(await sharp(`fixtures/example-set/bakery/photos/${file}`, { density: 300 }).resize(1080, 1080).jpeg().toBuffer());

const NOW = new Date('2026-11-01T14:00:00+02:00');

async function activeBusiness(postly: ReturnType<typeof createApp>, owner: string, postsPerWeek: number): Promise<string> {
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
    postsPerWeek,
    contact: { phone: '+972501234567' },
    approverPhone: owner,
  });
  await db.withSystem('console', async (tx) => {
    await tx.update(schema.business).set({ status: 'active', profile, style: 'warm' }).where(eq(schema.business.id, businessId));
    await tx.update(schema.conversationState).set({ step: 'idle' }).where(eq(schema.conversationState.businessId, businessId));
  });
  return businessId;
}

async function setup() {
  const storage = memoryStorage();
  const messagingSim = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const modelSim = new ModelSimulator();
  await storage.put('bundled/sample.jpg', await svgPhoto('oven.svg'), 'image/jpeg');
  const design = createDesignRenderer({
    assets: {
      load: async (url) => {
        const file = await storage.read(url);
        if (!file) throw new Error(`no stored file at ${url}`);
        return file.data;
      },
    },
    store: { put: (path, bytes, mimeType) => storage.put(path, bytes, mimeType) },
  });
  const providers = {
    messaging: messagingSim,
    publishing: new PublishingSimulator(),
    model: modelSim,
    payment: new PaymentSimulator(),
    renderer: { render: async () => ({}) },
    design,
  } satisfies Providers;
  const ref: { postly?: ReturnType<typeof createApp> } = {};
  let flushEach = true;
  const app: AppFactory = ({ messaging, publishing, model, design: recorded }) => {
    ref.postly = createApp({
      db,
      providers: { messaging, publishing, models: { google: model } },
      design: recorded!,
      media: storage,
      businessNumber: BUSINESS_PHONE,
      samplePhotoUrl: storage.urlFor('bundled/sample.jpg'),
      now: () => NOW,
    });
    return {
      async deliverInbound(message) {
        await ref.postly!.messaging.receive(message);
        if (flushEach) await ref.postly!.messaging.flushBursts();
      },
      close: () => design.close(),
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
const FACTS = [
  { id: 'f1', type: 'promotion', value: 'מבצע על חלות', sourceQuote: 'מבצע על חלות' },
  { id: 'f2', type: 'price', value: '2 חלות ב-25 ₪', sourceQuote: '2 ב-25 ₪' },
  { id: 'f3', type: 'date', value: 'עד יום שישי', sourceQuote: 'עד יום שישי' },
] as const;

const posts = (businessId: string) => db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.post).orderBy(schema.post.position));
const versions = (businessId: string, postId: string) =>
  db.withBusiness('content', businessId, (tx) => tx.select().from(schema.postVersion).where(eq(schema.postVersion.postId, postId)).orderBy(schema.postVersion.versionNumber));
const step = async (businessId: string) => (await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.conversationState)))[0]?.step;

e2eTest('a mismatched price blocks a draft; a change creates a new version and a saved rule', { timeout: 180_000 }, async ({ e2e }) => {
  const owner = '+972501230050';
  const { storage, messagingSim, modelSim, providers, app, ref, burst } = await setup();
  const run = await e2e.start({ providers, app, ownerPhone: owner, businessPhone: BUSINESS_PHONE, readMedia: storage.read, now: () => NOW });
  const postly = ref.postly!;
  const businessId = await activeBusiness(postly, owner, 2);

  modelSim.script('fact_extraction', { facts: [...FACTS], missingDetails: [] });
  modelSim.script('weekly_planning', (input) => ({
    posts: [
      { topic: 'מבצע חלות', contentType: 'promotions', format: 'single', factIds: ['f1', 'f2', 'f3'], mediaAssetIds: [...input.mediaAssetIds], brief: 'המבצע על החלות' },
      { topic: 'הבצק שלנו', contentType: 'behind_the_scenes', format: 'single', factIds: [], mediaAssetIds: [], brief: 'בצק שתופח 24 שעות' },
    ],
  }));
  // The promotion caption keeps writing the wrong price (20 instead of 25); the other is fine.
  const captionInputs: ModelTaskInput<'caption_writing'>[] = [];
  modelSim.setDefault('caption_writing', (input) => {
    captionInputs.push(input);
    const text =
      input.plan.topic === 'מבצע חלות'
        ? 'מבצע! 2 חלות ב-20 ₪ עד יום שישי'
        : input.changes
          ? 'הבצק שלנו תופח 24 שעות. בואו לטעום'
          : 'הבצק שלנו תופח 24 שעות!!! בואו לטעום!!!';
    return { captions: Object.fromEntries(input.networks.map((n) => [n, { text, hashtags: ['#מאפייה', '#חולון'] }])), usedFactIds: input.plan.factIds };
  });

  const photo = messagingSim.addMedia('image/jpeg', await svgPhoto('challah.svg'));
  await burst(async () => {
    await run.owner.sendsText(UPDATE_TEXT);
    await run.owner.sendsImage(photo);
  });

  // Only the behind-the-scenes draft reaches the owner; the wrong price never does.
  const [promo, dough] = await posts(businessId);
  expect([promo?.status, dough?.status]).toEqual(['needs_review', 'awaiting_approval']);
  const afterUpdate = run.owner.received();
  expect(afterUpdate.map((m) => m.kind)).toEqual(['text', 'buttons']);
  expect(afterUpdate[0]?.text).toBe(weeklyCopy.updateReceived(2));
  expect(afterUpdate.some((m) => m.text?.includes('20'))).toBe(false);
  expect(await versions(businessId, promo!.id)).toEqual([]);
  const captionRuns = await db.withBusiness('model', businessId, (tx) =>
    tx.select().from(schema.modelRun).where(eq(schema.modelRun.task, 'caption_writing')).orderBy(schema.modelRun.createdAt),
  );
  // The promotion's three attempts all failed the fact check; then the other post's one attempt passed.
  expect(captionRuns.map((r) => [r.valid, r.error?.split(':')[0]])).toEqual([
    [false, 'code check'],
    [false, 'code check'],
    [false, 'code check'],
    [true, undefined],
  ]);
  const items = await db.withSystem('console', (tx) => tx.select().from(schema.consoleItem).where(eq(schema.consoleItem.businessId, businessId)));
  expect(items.map((i) => i.kind)).toEqual(['model_validation_failed']);
  run.recordConsoleItems(items.map((i) => ({ kind: i.kind, details: i.details })));

  // The draft: version 1 with a content hash, the rendered image, and both buttons tied to the hash.
  const [v1] = await versions(businessId, dough!.id);
  expect(v1).toMatchObject({ versionNumber: 1, factCheckPassed: true });
  expect(v1?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  expect(Object.keys(v1!.renderedMedia as object).sort()).toEqual(['facebook', 'instagram']);
  const draft1 = afterUpdate[1]!;
  expect(draft1.image?.src).toMatch(/^data:image\/jpeg/);
  expect(draft1.buttons?.map((b) => [b.title, decodeButtonId(b.id)])).toEqual([
    [draftsCopy.APPROVE_TITLE, { action: 'approve', postId: dough!.id, versionHash: v1!.contentHash }],
    [draftsCopy.CHANGE_TITLE, { action: 'change', postId: dough!.id, versionHash: v1!.contentHash }],
  ]);
  expect(await step(businessId)).toBe('reviewing_drafts');

  // "Sounds good" is not an approval: the draft comes back with its buttons, unchanged.
  modelSim.script('intent_detection', { intent: 'other', confidence: 0.8 });
  await run.owner.sendsText('נשמע טוב');
  const resent = run.owner.received().slice(2);
  expect(resent.map((m) => m.text?.split('\n')[0] ?? m.kind)).toEqual([draftsCopy.notAnApproval, draft1.text?.split('\n')[0]]);
  expect(resent[1]?.buttons).toEqual(draft1.buttons);
  expect((await posts(businessId))[1]?.status).toBe('awaiting_approval');

  // Change: tap, then say what to change.
  await run.owner.tapsButton(draftsCopy.CHANGE_TITLE, { action: 'change', postId: dough!.id, versionHash: v1!.contentHash });
  expect(run.owner.received().at(-1)?.text).toBe(draftsCopy.askWhatToChange);
  modelSim.script('intent_detection', { intent: 'change_request', confidence: 0.9 });
  modelSim.script('change_interpretation', {
    changes: [{ target: 'caption', instruction: 'להוריד את סימני הקריאה' }],
    rule: { scope: 'caption', text: 'בלי סימני קריאה בכיתובים' },
  });
  await run.owner.sendsText('בלי סימני קריאה בבקשה');

  // A new version with a new hash and new buttons; the rule is saved and used.
  const [, v2] = await versions(businessId, dough!.id);
  expect(v2).toMatchObject({ versionNumber: 2, factCheckPassed: true });
  expect(v2!.contentHash).not.toBe(v1!.contentHash);
  expect((await posts(businessId))[1]).toMatchObject({ status: 'awaiting_approval', currentVersionId: v2!.id });
  const draft2 = run.owner.received().at(-1)!;
  expect(draft2.text).toContain('הבצק שלנו תופח 24 שעות. בואו לטעום');
  expect(draft2.text).not.toContain('!!!');
  expect(draft2.buttons?.map((b) => decodeButtonId(b.id)?.versionHash)).toEqual([v2!.contentHash, v2!.contentHash]);
  const rules = await db.withBusiness('business_data', businessId, (tx) => tx.select().from(schema.preferenceRule));
  const [changeMessage] = await db.withBusiness('content', businessId, (tx) =>
    tx.select().from(schema.message).where(and(eq(schema.message.direction, 'inbound'), eq(schema.message.body, 'בלי סימני קריאה בבקשה'))),
  );
  expect(rules.map((r) => [r.scope, r.rule, r.active, r.sourceMessageId, r.sourcePostVersionId])).toEqual([
    ['caption', 'בלי סימני קריאה בכיתובים', true, changeMessage!.id, v1!.id],
  ]);
  expect(captionInputs.at(-1)).toMatchObject({ preferenceRules: ['בלי סימני קריאה בכיתובים'], changes: ['להוריד את סימני הקריאה'] });
  expect(await step(businessId)).toBe('reviewing_drafts');

  // Nothing reaches the networks before approval (WP-33, WP-34).
  expect(run.networkPosts()).toEqual([]);
});

e2eTest('several photos for a single post: the owner chooses a carousel', { timeout: 180_000 }, async ({ e2e }) => {
  const owner = '+972501230051';
  const { storage, messagingSim, modelSim, providers, app, ref, burst } = await setup();
  const run = await e2e.start({ providers, app, ownerPhone: owner, businessPhone: BUSINESS_PHONE, readMedia: storage.read, now: () => NOW });
  const postly = ref.postly!;
  const businessId = await activeBusiness(postly, owner, 2);

  modelSim.script('fact_extraction', { facts: [{ id: 'f1', type: 'product', value: 'בורקס', sourceQuote: 'בורקס' }], missingDetails: [] });
  modelSim.script('weekly_planning', (input) => ({
    posts: [
      { topic: 'מגש בורקס טרי', contentType: 'products', format: 'single', factIds: ['f1'], mediaAssetIds: [...input.mediaAssetIds], brief: 'בורקס טרי מהתנור' },
      { topic: 'הבצק שלנו', contentType: 'behind_the_scenes', format: 'single', factIds: [], mediaAssetIds: [], brief: 'בצק שתופח 24 שעות' },
    ],
  }));
  const tray = messagingSim.addMedia('image/jpeg', await svgPhoto('bourekas-tray.svg'));
  const oven = messagingSim.addMedia('image/jpeg', await svgPhoto('oven.svg'));
  await burst(async () => {
    await run.owner.sendsText('הבורקס יצא מעולה השבוע');
    await run.owner.sendsImage(tray);
    await run.owner.sendsImage(oven);
  });

  // The first post waits for the owner's choice; nothing else is sent before it.
  expect(run.owner.received().map((m) => m.text)).toEqual([weeklyCopy.updateReceived(2), draftsCopy.photoChoiceQuestion(2, 'מגש בורקס טרי')]);
  expect(await step(businessId)).toBe('awaiting_answer');
  expect((await posts(businessId)).map((p) => p.status)).toEqual(['awaiting_clarification', 'planned']);

  // An unclear answer is asked again; "1" makes a carousel.
  await run.owner.sendsText('לא יודע');
  expect(run.owner.received().at(-1)?.text).toBe(draftsCopy.photoChoiceReask);
  await run.owner.sendsText('1');

  const [carousel, dough] = await posts(businessId);
  expect([carousel?.format, carousel?.status, dough?.status]).toEqual(['carousel', 'awaiting_approval', 'awaiting_approval']);
  const [version] = await versions(businessId, carousel!.id);
  expect((version!.renderedMedia as Record<string, string[]>).instagram).toHaveLength(2);
  const afterChoice = run.owner.received().slice(3);
  expect(afterChoice.map((m) => (m.kind === 'buttons' ? 'buttons' : m.text))).toEqual([
    draftsCopy.carouselSlide(1, 2),
    draftsCopy.carouselSlide(2, 2),
    'buttons',
    'buttons',
  ]);
  expect(await step(businessId)).toBe('reviewing_drafts');
  expect(run.networkPosts()).toEqual([]);
});

e2eTest('several photos for a single post: a post per photo', { timeout: 180_000 }, async ({ e2e }) => {
  const owner = '+972501230052';
  const { storage, messagingSim, modelSim, providers, app, ref, burst } = await setup();
  const run = await e2e.start({ providers, app, ownerPhone: owner, businessPhone: BUSINESS_PHONE, readMedia: storage.read, now: () => NOW });
  const postly = ref.postly!;
  const businessId = await activeBusiness(postly, owner, 2);

  modelSim.script('fact_extraction', { facts: [], missingDetails: [] });
  modelSim.script('weekly_planning', (input) => ({
    posts: [
      { topic: 'מה יצא מהתנור', contentType: 'products', format: 'single', factIds: [], mediaAssetIds: [...input.mediaAssetIds], brief: 'מה אפינו השבוע' },
      { topic: 'הבצק שלנו', contentType: 'behind_the_scenes', format: 'single', factIds: [], mediaAssetIds: [], brief: 'בצק שתופח 24 שעות' },
    ],
  }));
  const tray = messagingSim.addMedia('image/jpeg', await svgPhoto('bourekas-tray.svg'));
  const challah = messagingSim.addMedia('image/jpeg', await svgPhoto('challah.svg'));
  await burst(async () => {
    await run.owner.sendsImage(tray);
    await run.owner.sendsImage(challah);
  });
  await run.owner.sendsText('פוסט נפרד לכל תמונה');

  // Three single posts: the original keeps the first photo, a new one takes the second.
  const all = await posts(businessId);
  expect(all.map((p) => [p.position, p.format, p.status, (p.plan as { mediaAssetIds: string[] }).mediaAssetIds.length])).toEqual([
    [0, 'single', 'awaiting_approval', 1],
    [1, 'single', 'awaiting_approval', 0],
    [2, 'single', 'awaiting_approval', 1],
  ]);
  expect(run.owner.received().filter((m) => m.kind === 'buttons')).toHaveLength(3);
  expect(await step(businessId)).toBe('reviewing_drafts');
});
