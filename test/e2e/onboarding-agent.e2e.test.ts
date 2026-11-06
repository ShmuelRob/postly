/**
 * Onboarding through the agent (WP-92; PRD, How the agent works; agent.md). With the onboarding
 * flow switched on for the business, the onboarding agent asks the profile questions in its own
 * words, follows up on a vague answer, asks "anything else?", asks for the logo and photos, and
 * applies a correction; code decides when each step is done and runs the rest (style samples,
 * summary, approval by text, channel connection, activation, payment link). The agent is the scripted
 * agent (no real model): each turn below is what the model would answer, and every tool call still
 * goes through the real checks. Everything else is real except the vendors. Copy is provisional (H6),
 * the prompt is provisional (H7).
 */
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, expect, inject } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AgentTurnReport } from '../../src/simulators/scripted-agent.js';
import { call, step } from '../../src/simulators/scripted-agent.js';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { createDesignRenderer } from '../../src/modules/design/index.js';
import { BILLING_COPY } from '../../src/modules/billing/index.js';
import { WEBHOOK_PATH } from '../../src/modules/messaging/index.js';
import { onboardingCopy as copy } from '../../src/modules/workflow/index.js';
import { buildServer } from '../../src/server.js';
import { MessagingSimulator, ModelSimulator, PaymentSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { e2eTest, placeholderPng, type AppFactory, type Providers } from './harness/index.js';

const OWNER = '+972501230092';
const BUSINESS_PHONE = '+972521111192';
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

const svgPhoto = (file: string) => sharp(`fixtures/example-set/bakery/photos/${file}`, { density: 300 }).resize(1080, 1080).jpeg().toBuffer();

// What the owner writes, and the agent's questions (the scripted model's answers; feminine Hebrew).
const SAY = {
  hello: 'היי, נרשמתי לפוסטלי',
  business: 'קוראים לנו מאפיית בן עמי, מאפייה שכונתית. אנחנו אופים חלות, בורקס ועוגות שמרים',
  vague: 'אנחנו בחולון',
  location: 'רחוב הרצל 12. פתוחים א׳-ה׳ 7:00-19:00 ושישי 7:00-14:00. רק איסוף עצמי',
  different: 'הבצק שלנו תופח 24 שעות ואנחנו אופים כל בוקר מחדש. הלקוחות בעיקר משפחות מהשכונה',
  channels: 'אינסטגרם ופייסבוק. בשבת לא מפרסמים',
  nothingElse: 'לא, זה הכול',
  correction: 'בשישי אנחנו סוגרים ב-13:00',
};
const ASK = {
  business: 'נעים מאוד! איך קוראים לעסק, ומה אתם מוכרים?',
  where: 'איפה המאפייה נמצאת? כתובת ושעות פתיחה, ואם יש איסוף עצמי או משלוחים',
  address: 'ובאיזו כתובת בחולון? ומה שעות הפתיחה?',
  different: 'מה מייחד את המאפייה שלכם, ומי הלקוחות?',
  channels: 'באילו רשתות לפרסם: אינסטגרם, פייסבוק או שתיהן?',
  anythingElse: 'יש עוד משהו שחשוב שהלקוחות ידעו?',
  thanks: 'תודה, יש לי את כל מה שצריך!',
  logo: 'יש לכם לוגו? שלחו אותו כאן כתמונה',
  photos: 'קיבלתי את הלוגו, תודה! עכשיו שלחו כמה תמונות של המאפייה או של המוצרים',
  samplesSoon: 'איזה יופי! אני מכינה לכם דוגמאות',
};

e2eTest('a new owner onboards through the agent: follow-up questions, brand assets and a correction, then activation', { timeout: 180_000 }, async ({ e2e }) => {
  const storage = memoryStorage();
  const messagingSim = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const publishingSim = new PublishingSimulator();
  const modelSim = new ModelSimulator();
  const paymentSim = new PaymentSimulator();
  const logo = messagingSim.addMedia('image/png', placeholderPng(400, 400, [250, 245, 235], [140, 70, 30]));
  const photo = messagingSim.addMedia('image/jpeg', new Uint8Array(await svgPhoto('challah.svg')));
  await storage.put('bundled/sample.jpg', new Uint8Array(await svgPhoto('oven.svg')), 'image/jpeg');

  // One entry per agent turn, in order.
  modelSim.scriptAgent(
    'onboarding',
    // After the intro: the first question.
    [step(call.askOwner(ASK.business, { topic: 'profile:name' }))],
    // Name, field and products, then the location question.
    [
      step(
        call.setProfileField('name', 'מאפיית בן עמי', 'מאפיית בן עמי'),
        call.setProfileField('field', 'מאפייה שכונתית', 'מאפייה שכונתית'),
        call.setProfileField('mainProducts', ['חלות', 'בורקס', 'עוגות שמרים'], 'חלות, בורקס ועוגות שמרים'),
      ),
      step(call.askOwner(ASK.where, { topic: 'profile:location' })),
    ],
    // A vague answer: the city is kept, and one follow-up asks for the rest.
    [step(call.setProfileField('location.city', 'חולון', 'בחולון')), step(call.askOwner(ASK.address, { topic: 'profile:location' }))],
    // The rest of the location completes it; then what makes the business different.
    [
      step(
        call.setProfileField('location.address', 'רחוב הרצל 12', 'רחוב הרצל 12'),
        call.setProfileField('location.hours', 'א׳-ה׳ 7:00-19:00, שישי 7:00-14:00', 'פתוחים א׳-ה׳ 7:00-19:00 ושישי 7:00-14:00'),
        call.setProfileField('location.fulfillment', ['pickup'], 'רק איסוף עצמי'),
      ),
      step(call.askOwner(ASK.different, { topic: 'profile:differentiator' })),
    ],
    [
      step(
        call.setProfileField('differentiator', 'בצק שתופח 24 שעות ואפייה טרייה כל בוקר', 'הבצק שלנו תופח 24 שעות ואנחנו אופים כל בוקר מחדש'),
        call.setProfileField('targetAudience', 'משפחות מהשכונה', 'משפחות מהשכונה'),
      ),
      step(call.askOwner(ASK.channels, { topic: 'profile:channels' })),
    ],
    // Channels: every required field is set, so the closing question.
    [step(call.setProfileField('channels', ['instagram', 'facebook'])), step(call.askOwner(ASK.anythingElse, { topic: 'anything_else' }))],
    // The answer to "anything else?": the agent only ends its turn, as the rule agent did on dev on
    // 2026-11-06. Code still evaluates the done rule after end_turn (agent.md), so the owner is not
    // left without a reply: the profile questions are done and brand assets start.
    [step({ tool: 'end_turn' })],
    // brand_assets, started by code: the logo request.
    [step(call.requestPhoto('logo', ASK.logo))],
    // The logo arrived (code saved it): now the photos.
    [step(call.requestPhoto('business', ASK.photos))],
    // A photo arrived: done; code sends the style samples.
    [step(call.askOwner(ASK.samplesSoon, { topic: 'info', expects: 'none' }))],
    // profile_review: the correction, keeping the hours the owner gave before.
    [step(call.setProfileField('location.hours', 'א׳-ה׳ 7:00-19:00, שישי 7:00-13:00', 'בשישי אנחנו סוגרים ב-13:00'))],
  );

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
  const providers = { messaging: messagingSim, publishing: publishingSim, model: modelSim, payment: paymentSim, renderer: { render: async () => ({}) }, design } satisfies Providers;
  await db.withSystem('console', (tx) => tx.update(schema.business).set({ approverPhone: `+9720${Date.now()}` }).where(eq(schema.business.approverPhone, OWNER)));

  let onboarding: ReturnType<typeof createApp>['onboarding'] | undefined;
  let record: (turn: AgentTurnReport) => void = () => {};
  const app: AppFactory = ({ messaging: messagingProvider, publishing, model, design: recordedDesign }) => {
    const postly = createApp({
      db,
      providers: { messaging: messagingProvider, publishing, models: { google: model }, payment: paymentSim },
      design: recordedDesign!,
      media: storage,
      businessNumber: BUSINESS_PHONE,
      samplePhotoUrl: storage.urlFor('bundled/sample.jpg'),
      onAgentTurnEnd: (turn) => record(turn as AgentTurnReport),
    });
    onboarding = postly.onboarding;
    const server = buildServer({ messaging: postly.messaging, billing: postly.billing!, publicBaseUrl: 'https://postly.example.test' });
    return {
      async deliverInbound(message) {
        const hook = messagingSim.webhook(message);
        const res = await server.inject({ method: 'POST', url: WEBHOOK_PATH, headers: hook.headers, payload: hook.body });
        expect(res.statusCode).toBe(200);
        await postly.messaging.flushBursts();
      },
      close: async () => {
        await server.close();
        await design.close();
      },
    };
  };
  const run = await e2e.start({ providers, app, ownerPhone: OWNER, businessPhone: BUSINESS_PHONE, readMedia: storage.read });
  record = (turn) => run.recordAgentTurn(turn);

  // Sign-up creates the business; the team switches the onboarding agent on for it.
  const businessId = await onboarding!.createBusiness({ approverPhone: OWNER });
  await db.withBusiness('workflow', businessId, (tx) => tx.update(schema.business).set({ agentFlows: { onboarding: true } }).where(eq(schema.business.id, businessId)));
  const said = () => run.owner.received().map((m) => m.text);
  const lastSaid = () => said().at(-1);

  // 1. The persona introduces herself (feminine Hebrew), and the agent asks the first question.
  await run.owner.sendsText(SAY.hello);
  expect(said()).toEqual([copy.intro('פוסטלי'), ASK.business]);
  expect(said()[0]).toContain('אני פוסטלי, סוכנת הסושיאל');

  // 2. Answers are saved only from the owner's own words; a vague answer gets a follow-up.
  await run.owner.sendsText(SAY.business);
  expect(lastSaid()).toBe(ASK.where);
  await run.owner.sendsText(SAY.vague);
  expect(lastSaid()).toBe(ASK.address);
  await run.owner.sendsText(SAY.location);
  expect(lastSaid()).toBe(ASK.different);
  await run.owner.sendsText(SAY.different);
  expect(lastSaid()).toBe(ASK.channels);
  await run.owner.sendsText(SAY.channels);
  expect(lastSaid()).toBe(ASK.anythingElse);

  // 3. The closing question answered: code applies PROFILE_FIELDS_COMPLETE; the agent asks for the logo.
  await run.owner.sendsText(SAY.nothingElse);
  expect(said().slice(-2)).toEqual([ASK.anythingElse, ASK.logo]);

  // 4. Brand assets: code stores the logo and the photo; then code sends the style samples.
  await run.owner.sendsImage(logo);
  expect(lastSaid()).toBe(ASK.photos);
  await run.owner.sendsImage(photo, 'החלות שלנו');
  const samples = run.owner.received().slice(-6);
  expect(samples.map((m) => m.text)).toEqual([ASK.samplesSoon, copy.samplesIntro, copy.sampleCaption.clean, copy.sampleCaption.warm, copy.sampleCaption.dynamic, copy.chooseStyle]);

  // 5. Code reads the style choice and sends the summary; the agent applies a correction, and code resends it.
  await run.owner.sendsText('2');
  expect(lastSaid()).toContain('שישי 7:00-14:00');
  await run.owner.sendsText(SAY.correction);
  expect(lastSaid()).toContain('שישי 7:00-13:00');
  expect(lastSaid()).toContain('• סגנון: חם');

  // 6. Approval by text, channel connection and activation stay code; the payment link follows.
  await run.owner.sendsText('מאשר');
  expect(lastSaid()).toMatch(/^מצוין! הצעד האחרון: חיבור הרשתות/);
  publishingSim.connect(businessId, 'instagram');
  publishingSim.connect(businessId, 'facebook');
  await run.owner.sendsText('חיברתי');
  const [payLink] = paymentSim.links;
  expect(said().slice(-2)).toEqual([copy.activated, BILLING_COPY.paymentLink(payLink!.link.url, 30000)]);

  // The business is active with the profile the agent gathered; nothing was published.
  const stored = await db.withBusiness('workflow', businessId, async (tx) => ({
    business: (await tx.select().from(schema.business))[0]!,
    turns: await tx.select().from(schema.agentTurn),
  }));
  expect(stored.business).toMatchObject({ status: 'active', name: 'מאפיית בן עמי', style: 'warm' });
  expect(stored.business.profile).toMatchObject({
    name: 'מאפיית בן עמי',
    field: 'מאפייה שכונתית',
    mainProducts: ['חלות', 'בורקס', 'עוגות שמרים'],
    location: { city: 'חולון', address: 'רחוב הרצל 12', hours: 'א׳-ה׳ 7:00-19:00, שישי 7:00-13:00', fulfillment: ['pickup'] },
    differentiator: 'בצק שתופח 24 שעות ואפייה טרייה כל בוקר',
    targetAudience: 'משפחות מהשכונה',
    channels: ['instagram', 'facebook'],
    brand: { logoAssetId: expect.any(String) },
  });
  expect(stored.turns).toHaveLength(11);
  expect(stored.turns.every((t) => t.agent === 'onboarding' && t.status !== 'failed' && t.status !== 'handed_off')).toBe(true);
  expect(run.networkPosts()).toEqual([]);
});
