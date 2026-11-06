/**
 * Onboarding (WP-30, PRD "WhatsApp onboarding"): a new owner goes from the first WhatsApp message
 * to an active business, in Hebrew, answering partly by voice. Everything is real (the webhook,
 * messaging with media storage, the workflow, the model layer with its seeded prompts, the design
 * engine with Playwright, the publishing module, and the database) except the vendors, which are
 * the simulators. The conversation copy is provisional (H6).
 */
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, expect, inject } from 'vitest';
import { createApp } from '../../src/app.js';
import type { BusinessProfileDraft } from '../../src/contracts/business-profile.js';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { createDesignRenderer } from '../../src/modules/design/index.js';
import { BILLING_COPY, PAYMENT_WEBHOOK_PATH } from '../../src/modules/billing/index.js';
import { WEBHOOK_PATH } from '../../src/modules/messaging/index.js';
import { onboardingCopy as copy } from '../../src/modules/workflow/index.js';
import { buildServer } from '../../src/server.js';
import { MessagingSimulator, ModelSimulator, PaymentSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { e2eTest, placeholderPng, type AppFactory, type Providers } from './harness/index.js';

const OWNER = '+972501230030';
const BUSINESS_PHONE = '+972521111130';
const MEDIA_ORIGIN = 'https://media.postly.test/';

const db = createDatabase(inject('databaseUrls'), { max: 3 });
afterAll(() => db.close());

/** In-memory file storage standing in for Cloud Storage, shared by messaging, the renderer, and the report. */
function memoryStorage() {
  const files = new Map<string, { mimeType: string; data: Uint8Array }>();
  return {
    files,
    async put(path: string, data: Uint8Array, mimeType: string) {
      files.set(path, { mimeType, data });
    },
    urlFor: (path: string) => MEDIA_ORIGIN + path,
    read: async (ref: string) => files.get(ref.startsWith(MEDIA_ORIGIN) ? ref.slice(MEDIA_ORIGIN.length) : ref),
  };
}

const svgPhoto = (file: string) => sharp(`fixtures/example-set/bakery/photos/${file}`, { density: 300 }).resize(1080, 1080).jpeg().toBuffer();

/** What the owner says, and what profile_extraction finds in it (the model simulator's answers). */
const VOICE_NAME = 'קוראים לנו מאפיית בן עמי, מאפייה שכונתית. אנחנו אופים חלות, בורקס ועוגות שמרים';
const VOICE_DIFFERENTIATOR = 'הבצק שלנו תופח 24 שעות, ואנחנו אופים כל בוקר מחדש';
const extractions: Record<string, BusinessProfileDraft> = {
  [VOICE_NAME]: { name: 'מאפיית בן עמי', field: 'מאפייה שכונתית', mainProducts: ['חלות', 'בורקס', 'עוגות שמרים'] },
  'רחוב הרצל 12 בחולון. פתוחים א׳-ה׳ 7:00-19:00 ושישי 7:00-14:00. רק איסוף עצמי': {
    location: { city: 'חולון', address: 'רחוב הרצל 12', hours: 'א׳-ה׳ 7:00-19:00, שישי 7:00-14:00', fulfillment: ['pickup'] },
  },
  'בעיקר משפחות מהשכונה': { targetAudience: 'משפחות מהשכונה' },
  [VOICE_DIFFERENTIATOR]: { differentiator: 'בצק שתופח 24 שעות ואפייה טרייה כל בוקר' },
  'אינסטגרם ופייסבוק. בשבת לא מפרסמים': { channels: ['instagram', 'facebook'], schedule: { publishOnShabbatAndHolidays: false, days: [], hours: [] } },
  'בשישי אנחנו סוגרים ב-13:00': {
    location: { city: 'חולון', address: 'רחוב הרצל 12', hours: 'א׳-ה׳ 7:00-19:00, שישי 7:00-13:00', fulfillment: ['pickup'] },
  },
};

e2eTest('a new owner onboards in Hebrew, partly by voice, and the business becomes active', { timeout: 180_000 }, async ({ e2e }) => {
  const storage = memoryStorage();
  const messagingSim = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const publishingSim = new PublishingSimulator();
  const modelSim = new ModelSimulator();
  modelSim.setDefault('profile_extraction', (input) => ({ found: extractions[input.text] ?? {}, unclear: [] }));
  const paymentSim = new PaymentSimulator();

  const voiceName = messagingSim.addMedia('audio/ogg', new Uint8Array([1, 2, 3]));
  const voiceDifferentiator = messagingSim.addMedia('audio/ogg', new Uint8Array([4, 5, 6]));
  const logo = messagingSim.addMedia('image/png', placeholderPng(400, 400, [250, 245, 235], [140, 70, 30]));
  const photo = messagingSim.addMedia('image/jpeg', new Uint8Array(await svgPhoto('challah.svg')));
  await storage.put('bundled/sample.jpg', new Uint8Array(await svgPhoto('oven.svg')), 'image/jpeg');

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
    publishing: publishingSim,
    model: modelSim,
    payment: paymentSim,
    renderer: { render: async () => ({}) },
    design,
  } satisfies Providers;

  // approver_phone is unique: free the fixture number from an earlier run first.
  await db.withSystem('console', (tx) =>
    tx.update(schema.business).set({ approverPhone: `+9720${Date.now()}` }).where(eq(schema.business.approverPhone, OWNER)),
  );

  let onboarding: ReturnType<typeof createApp>['onboarding'] | undefined;
  let deliverPayment = async (_subscriptionId: string) => 0;
  const app: AppFactory = ({ messaging: messagingProvider, publishing, model, design: recordedDesign }) => {
    const postly = createApp({
      db,
      providers: { messaging: messagingProvider, publishing, models: { google: model }, payment: paymentSim },
      design: recordedDesign!,
      media: storage,
      businessNumber: BUSINESS_PHONE,
      samplePhotoUrl: storage.urlFor('bundled/sample.jpg'),
    });
    onboarding = postly.onboarding;
    const server = buildServer({ messaging: postly.messaging, billing: postly.billing!, publicBaseUrl: 'https://postly.example.test' });
    deliverPayment = async (subscriptionId) => {
      const hook = paymentSim.webhook(subscriptionId);
      return (await server.inject({ method: 'POST', url: PAYMENT_WEBHOOK_PATH, headers: hook.headers, payload: hook.body })).statusCode;
    };
    return {
      async deliverInbound(message) {
        const hook = messagingSim.webhook(message);
        const res = await server.inject({ method: 'POST', url: WEBHOOK_PATH, headers: hook.headers, payload: hook.body });
        expect(res.statusCode).toBe(200);
        // The 20-second quiet window passes before the owner's next message.
        await postly.messaging.flushBursts();
      },
      close: async () => {
        await server.close();
        await design.close();
      },
    };
  };
  const run = await e2e.start({ providers, app, ownerPhone: OWNER, businessPhone: BUSINESS_PHONE, readMedia: storage.read });

  // Signing up (a team or sign-up action) creates the business; the owner then writes first.
  const businessId = await onboarding!.createBusiness({ approverPhone: OWNER });

  const said = () => run.owner.received().map((m) => m.text);
  const lastSaid = () => said().at(-1);

  // 1. Intro and the first profile question.
  await run.owner.sendsText('היי, נרשמתי לפוסטלי');
  expect(said()).toEqual([copy.intro('פוסטלי'), copy.questions.business]);

  // 2. A voice answer: transcribed, then the profile fields are extracted from the transcript.
  modelSim.scriptTranscription({ text: VOICE_NAME, language: 'he' });
  await run.owner.sendsVoice(voiceName);
  expect(lastSaid()).toBe(copy.questions.location);

  await run.owner.sendsText('רחוב הרצל 12 בחולון. פתוחים א׳-ה׳ 7:00-19:00 ושישי 7:00-14:00. רק איסוף עצמי');
  expect(lastSaid()).toBe(copy.questions.audience);

  // 3. A partial answer: the differentiator is still missing, so the question is asked again.
  await run.owner.sendsText('בעיקר משפחות מהשכונה');
  expect(lastSaid()).toBe(copy.reask(copy.questions.audience));

  modelSim.scriptTranscription({ text: VOICE_DIFFERENTIATOR, language: 'he' });
  await run.owner.sendsVoice(voiceDifferentiator);
  expect(lastSaid()).toBe(copy.questions.channels);

  await run.owner.sendsText('אינסטגרם ופייסבוק. בשבת לא מפרסמים');
  expect(lastSaid()).toBe(copy.askLogo);

  // 4. Brand assets: the logo, then a photo, then done.
  await run.owner.sendsImage(logo);
  expect(said().slice(-2)).toEqual([copy.logoSaved, copy.askPhotos]);
  await run.owner.sendsImage(photo, 'החלות שלנו');
  expect(lastSaid()).toBe(copy.photosReceived(1));

  // 5. Style samples: one post per style from the owner's photo, sent as images.
  await run.owner.sendsText('סיימתי');
  const samples = run.owner.received().slice(-5);
  expect(samples.map((m) => m.text)).toEqual([copy.samplesIntro, copy.sampleCaption.clean, copy.sampleCaption.warm, copy.sampleCaption.dynamic, copy.chooseStyle]);
  for (const m of samples.slice(1, 4)) expect(m.image?.src).toMatch(/^data:image\/jpeg;base64,/);
  expect(run.renders().map((r) => [r.style, r.network, r.width, r.height])).toEqual([
    ['clean', 'instagram', 1080, 1350],
    ['warm', 'instagram', 1080, 1350],
    ['dynamic', 'instagram', 1080, 1350],
  ]);

  // 6. The owner picks Warm and gets the profile summary; a correction resends it.
  await run.owner.sendsText('2');
  expect(lastSaid()).toContain('• סגנון: חם');
  expect(lastSaid()).toContain('שישי 7:00-14:00');
  await run.owner.sendsText('בשישי אנחנו סוגרים ב-13:00');
  expect(lastSaid()).toContain('שישי 7:00-13:00');

  // 7. Approval by text from the approver number, then the connection link.
  await run.owner.sendsText('מאשר');
  expect(lastSaid()).toMatch(/^מצוין! הצעד האחרון: חיבור הרשתות/);
  const link = publishingSim.connectionLinks.at(-1)!;
  expect(link.request).toEqual({ businessId, networks: ['instagram', 'facebook'] });
  expect(lastSaid()).toContain(link.link.url);

  // 8. Writing before connecting gets the link again; after connecting, the channels are tested.
  await run.owner.sendsText('חיברתי');
  expect(lastSaid()).toMatch(/^עדיין לא רואה חיבור/);
  publishingSim.connect(businessId, 'instagram');
  publishingSim.connect(businessId, 'facebook');
  await run.owner.sendsText('חיברתי');

  // 9. No trial (T1): activation is followed at once by the payment link, at the price setting (ILS 300).
  const [payLink] = paymentSim.links;
  expect(payLink?.request).toEqual({ businessId, plan: 'basic', price: { amountAgorot: 30000, currency: 'ILS' } });
  expect(said().slice(-2)).toEqual([copy.activated, BILLING_COPY.paymentLink(payLink!.link.url, 30000)]);
  expect(lastSaid()).toContain('300 ₪ לחודש');
  const subscriptionOf = async () => (await db.withBusiness('billing', businessId, (tx) => tx.select().from(schema.subscription)))[0];
  expect(await subscriptionOf()).toMatchObject({ status: 'pending', plan: 'basic', providerCustomerId: payLink!.link.providerCustomerId });

  // The owner pays on the provider's page; the provider's callback makes the subscription active.
  const subscriptionId = paymentSim.completePayment(payLink!.link.providerCustomerId);
  expect(await deliverPayment(subscriptionId)).toBe(200);
  expect(await subscriptionOf()).toMatchObject({ status: 'active', providerSubscriptionId: subscriptionId });
  expect(lastSaid()).toBe(BILLING_COPY.active);

  // The business is active with the full profile; nothing was published.
  const stored = await db.withBusiness('workflow', businessId, async (tx) => ({
    business: (await tx.select().from(schema.business))[0]!,
    state: (await tx.select().from(schema.conversationState))[0]!,
    channels: await tx.select().from(schema.channelConnection),
  }));
  expect(stored.business).toMatchObject({ status: 'active', name: 'מאפיית בן עמי', style: 'warm' });
  expect(stored.business.profile).toMatchObject({
    name: 'מאפיית בן עמי',
    approverPhone: OWNER,
    style: 'warm',
    channels: ['instagram', 'facebook'],
    postsPerWeek: 3,
    languages: ['he'],
    location: { hours: 'א׳-ה׳ 7:00-19:00, שישי 7:00-13:00' },
    brand: { logoAssetId: expect.any(String) },
  });
  expect(stored.state).toMatchObject({ step: 'idle', openQuestion: null, handoffAt: null });
  expect(stored.channels.map((c) => [c.network, c.status]).sort()).toEqual([
    ['facebook', 'verified'],
    ['instagram', 'verified'],
  ]);
  expect(run.networkPosts()).toEqual([]);
  expect(run.modelCalls().filter((c) => c.method === 'transcribeAudio')).toHaveLength(2);
});

e2eTest('a profile question unanswered three times hands the conversation to a person', { timeout: 60_000 }, async ({ e2e }) => {
  const owner = '+972501230031';
  const messagingSim = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const storage = memoryStorage();
  const providers = {
    messaging: messagingSim,
    publishing: new PublishingSimulator(),
    model: new ModelSimulator(),
    payment: new PaymentSimulator(),
    renderer: { render: async () => ({}) },
  } satisfies Providers;
  await db.withSystem('console', (tx) =>
    tx.update(schema.business).set({ approverPhone: `+9721${Date.now()}` }).where(eq(schema.business.approverPhone, owner)),
  );
  let onboarding: ReturnType<typeof createApp>['onboarding'] | undefined;
  const app: AppFactory = ({ messaging, publishing, model }) => {
    const postly = createApp({
      db,
      providers: { messaging, publishing, models: { google: model } },
      design: { forBusiness: () => ({ render: async () => ({}) }) },
      media: storage,
      businessNumber: BUSINESS_PHONE,
      samplePhotoUrl: storage.urlFor('none'),
    });
    onboarding = postly.onboarding;
    return {
      async deliverInbound(message) {
        await postly.messaging.receive(message);
        await postly.messaging.flushBursts();
      },
    };
  };
  const run = await e2e.start({ providers, app, ownerPhone: owner, businessPhone: BUSINESS_PHONE });
  const businessId = await onboarding!.createBusiness({ approverPhone: owner });

  await run.owner.sendsText('שלום');
  for (const answer of ['לא יודע', 'אממ', 'מה?']) await run.owner.sendsText(answer);
  await run.owner.sendsText('עכשיו?');

  expect(run.owner.received().map((m) => m.text)).toEqual([
    copy.intro('פוסטלי'),
    copy.questions.business,
    copy.reask(copy.questions.business),
    copy.reask(copy.questions.business),
    copy.handoff,
  ]);
  const items = await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.consoleItem));
  run.recordConsoleItems(items.map((i) => ({ kind: i.kind, details: i.details })));
  expect(items).toMatchObject([{ kind: 'handoff', status: 'open' }]);
});

/** A business whose onboarding stopped at `step`, with a complete profile and both channels chosen. */
async function stoppedAt(
  onboarding: ReturnType<typeof createApp>['onboarding'],
  owner: string,
  step: 'channel_test' | 'completed',
  channels: Array<{ network: 'instagram' | 'facebook'; status: 'connected' | 'verified' }>,
) {
  await db.withSystem('console', (tx) =>
    tx.update(schema.business).set({ approverPhone: `+9722${Date.now()}` }).where(eq(schema.business.approverPhone, owner)),
  );
  const businessId = await onboarding.createBusiness({ approverPhone: owner });
  const profile = {
    ...extractions[VOICE_NAME],
    location: { city: 'חולון', address: 'רחוב הרצל 12', hours: 'א׳-ה׳ 7:00-19:00', fulfillment: ['pickup'] },
    differentiator: 'בצק שתופח 24 שעות',
    channels: ['instagram', 'facebook'],
    style: 'warm',
    approverPhone: owner,
  };
  await db.withBusiness('workflow', businessId, async (tx) => {
    await tx.update(schema.business).set({ profile, name: 'מאפיית בן עמי', style: 'warm' }).where(eq(schema.business.id, businessId));
    await tx.update(schema.conversationState).set({ step }).where(eq(schema.conversationState.businessId, businessId));
  });
  await db.withBusiness('publishing', businessId, (tx) =>
    tx.insert(schema.channelConnection).values(
      channels.map((c) => ({ businessId, network: c.network, provider: 'simulator', status: c.status, providerAccountId: `acct-${c.network}` })),
    ),
  );
  return businessId;
}

/** The app without the design engine; `hold` delays the first text send to the owner. */
function plainApp(storage: ReturnType<typeof memoryStorage>, hold?: () => Promise<void>, payment?: PaymentSimulator) {
  const ref: { postly?: ReturnType<typeof createApp> } = {};
  const app: AppFactory = ({ messaging, publishing, model }) => {
    const slowMessaging: typeof messaging = hold
      ? {
          name: messaging.name,
          sendText: async (request) => {
            await hold();
            return messaging.sendText(request);
          },
          sendTemplate: (request) => messaging.sendTemplate(request),
          sendButtons: (request) => messaging.sendButtons(request),
          getMedia: (id) => messaging.getMedia(id),
          verifyWebhook: (request) => messaging.verifyWebhook(request),
        }
      : messaging;
    ref.postly = createApp({
      db,
      providers: { messaging: slowMessaging, publishing, models: { google: model }, ...(payment ? { payment } : {}) },
      design: { forBusiness: () => ({ render: async () => ({}) }) },
      media: storage,
      businessNumber: BUSINESS_PHONE,
      samplePhotoUrl: storage.urlFor('none'),
      // No quiet window, so a sweep may pick up a message at once.
      burstQuietMs: 0,
    });
    return {
      async deliverInbound(message) {
        await ref.postly!.messaging.receive(message);
        await ref.postly!.messaging.flushBursts();
      },
    };
  };
  return { app, ref };
}

const providersWith = (publishing = new PublishingSimulator()) =>
  ({
    messaging: new MessagingSimulator({ businessNumber: BUSINESS_PHONE }),
    publishing,
    model: new ModelSimulator(),
    payment: new PaymentSimulator(),
    renderer: { render: async () => ({}) },
  }) satisfies Providers;

e2eTest('onboarding stopped in channel_test resumes the test on the next message', { timeout: 60_000 }, async ({ e2e }) => {
  const owner = '+972501230032';
  const publishing = new PublishingSimulator();
  const { app, ref } = plainApp(memoryStorage());
  const run = await e2e.start({ providers: providersWith(publishing), app, ownerPhone: owner, businessPhone: BUSINESS_PHONE });
  const businessId = await stoppedAt(ref.postly!.onboarding, owner, 'channel_test', [
    { network: 'instagram', status: 'connected' },
    { network: 'facebook', status: 'verified' },
  ]);
  publishing.connect(businessId, 'instagram', 'acct-instagram');

  await run.owner.sendsText('היי, מה קורה?');

  expect(run.owner.received().map((m) => m.text)).toEqual([copy.activated]);
  const business = await db.withBusiness('workflow', businessId, async (tx) => (await tx.select().from(schema.business))[0]);
  expect(business?.status).toBe('active');
});

e2eTest('onboarding stopped after the test passed activates the business on the next message', { timeout: 60_000 }, async ({ e2e }) => {
  const owner = '+972501230033';
  const { app, ref } = plainApp(memoryStorage());
  const run = await e2e.start({ providers: providersWith(), app, ownerPhone: owner, businessPhone: BUSINESS_PHONE });
  const businessId = await stoppedAt(ref.postly!.onboarding, owner, 'completed', [
    { network: 'instagram', status: 'verified' },
    { network: 'facebook', status: 'verified' },
  ]);

  await run.owner.sendsText('היי');

  expect(run.owner.received().map((m) => m.text)).toEqual([copy.activated]);
  const state = await db.withBusiness('workflow', businessId, async (tx) => ({
    business: (await tx.select().from(schema.business))[0],
    conversation: (await tx.select().from(schema.conversationState))[0],
  }));
  expect(state.business?.status).toBe('active');
  expect(state.conversation?.step).toBe('idle');
});

e2eTest('a payment link that fails to send after activation opens a console item; the business stays active', { timeout: 60_000 }, async ({ e2e }) => {
  const owner = '+972501230036';
  const payment = new PaymentSimulator();
  payment.createPaymentLink = async () => {
    throw new Error('provider down');
  };
  const { app, ref } = plainApp(memoryStorage(), undefined, payment);
  const run = await e2e.start({ providers: providersWith(), app, ownerPhone: owner, businessPhone: BUSINESS_PHONE });
  const businessId = await stoppedAt(ref.postly!.onboarding, owner, 'completed', [
    { network: 'instagram', status: 'verified' },
    { network: 'facebook', status: 'verified' },
  ]);

  await run.owner.sendsText('היי');

  expect(run.owner.received().map((m) => m.text)).toEqual([copy.activated]);
  const items = await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.consoleItem));
  run.recordConsoleItems(items.map((i) => ({ kind: i.kind, details: i.details })));
  expect(items).toMatchObject([{ kind: 'payment_link_failed', status: 'open', details: { error: 'Error: provider down' } }]);
  const business = await db.withBusiness('workflow', businessId, async (tx) => (await tx.select().from(schema.business))[0]);
  expect(business?.status).toBe('active');
});

e2eTest('onboarding that cannot activate tells the owner and hands off to a person', { timeout: 60_000 }, async ({ e2e }) => {
  const owner = '+972501230034';
  const { app, ref } = plainApp(memoryStorage());
  const run = await e2e.start({ providers: providersWith(), app, ownerPhone: owner, businessPhone: BUSINESS_PHONE });
  // The channel lost its verification after the test: nothing is verified any more.
  const businessId = await stoppedAt(ref.postly!.onboarding, owner, 'completed', [{ network: 'instagram', status: 'connected' }]);

  await run.owner.sendsText('היי');

  expect(run.owner.received().map((m) => m.text)).toEqual([copy.handoff]);
  const items = await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.consoleItem));
  run.recordConsoleItems(items.map((i) => ({ kind: i.kind, details: i.details })));
  expect(items).toMatchObject([{ kind: 'handoff', status: 'open', details: { reason: 'activation guard failed after the channel test' } }]);
  const business = await db.withBusiness('workflow', businessId, async (tx) => (await tx.select().from(schema.business))[0]);
  expect(business?.status).toBe('onboarding');
});

e2eTest('a sweep during a slow reply hands the message over once: one reply, one state change', { timeout: 60_000 }, async ({ e2e }) => {
  const owner = '+972501230035';
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  const { app, ref } = plainApp(memoryStorage(), async () => {
    if (held) return;
    held = true;
    await gate;
  });
  const run = await e2e.start({ providers: providersWith(), app, ownerPhone: owner, businessPhone: BUSINESS_PHONE });
  await db.withSystem('console', (tx) =>
    tx.update(schema.business).set({ approverPhone: `+9723${Date.now()}` }).where(eq(schema.business.approverPhone, owner)),
  );
  const businessId = await ref.postly!.onboarding.createBusiness({ approverPhone: owner });

  // The first reply is slow; while it is being sent, the sweep runs.
  const sending = run.owner.sendsText('היי');
  // Wait until the reply is being sent (up to 5 s) instead of a fixed sleep, which raced the handler.
  for (let i = 0; i < 100 && !held; i++) await new Promise((r) => setTimeout(r, 50));
  expect(held).toBe(true);
  await ref.postly!.messaging.sweepUnprocessed({ businessId });
  release();
  await sending;
  await ref.postly!.messaging.sweepUnprocessed({ businessId });

  expect(run.owner.received().map((m) => m.text)).toEqual([copy.intro('פוסטלי'), copy.questions.business]);
  const state = await db.withBusiness('workflow', businessId, async (tx) => (await tx.select().from(schema.conversationState))[0]);
  expect(state?.step).toBe('profile_questions');
  expect(state?.openQuestion).toMatchObject({ key: 'business', attempts: 1 });
});
