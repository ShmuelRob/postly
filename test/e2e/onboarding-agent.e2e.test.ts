/**
 * Onboarding through the agent (WP-92; PRD, WhatsApp onboarding; agent.md, A11: batched onboarding).
 * Onboarding always runs on the agent (outside the one-shot test compositions). Code sends the first
 * half of the profile questions (batch A) right after the intro, with no model call. The owner answers
 * over two messages, merged into one burst by the quiet window; one agent step saves every field it
 * finds and asks its follow-up, and code appends batch B to that same message. One more step saves
 * batch B and ends the turn; code sees the profile done and the agent asks for the logo and photos.
 * Code runs the rest (style samples, summary, a correction through the agent, approval by text,
 * channel connection, activation, payment link). The agent is the scripted agent (no real model): each
 * turn below is what the model would answer, and every tool call still goes through the real checks.
 * Copy is provisional (H6), the prompt is provisional (H7).
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
import { onboardingBatches } from '../../src/modules/agent/index.js';
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
  // Batch A's answer, typed as two messages: one burst.
  aboutUs: 'קוראים לנו מאפיית בן עמי, מאפייה שכונתית. אנחנו אופים חלות, בורקס ועוגות שמרים',
  where: 'אנחנו בחולון, פתוחים א׳-ה׳ 7:00-19:00 ושישי 7:00-14:00. רק איסוף עצמי',
  // The follow-up and batch B, in one answer.
  batchB: 'רחוב הרצל 12. הלקוחות בעיקר משפחות מהשכונה. הבצק שלנו תופח 24 שעות ואנחנו אופים כל בוקר מחדש. אינסטגרם ופייסבוק, בשבת לא מפרסמים. זה הכול',
  correction: 'בשישי אנחנו סוגרים ב-13:00',
};
const ASK = {
  // The agent's follow-up on batch A; code appends batch B to it.
  address: 'תודה! ובאיזו כתובת בחולון?',
  logo: 'יש לכם לוגו? שלחו אותו כאן כתמונה',
  photos: 'קיבלתי את הלוגו, תודה! עכשיו שלחו כמה תמונות של המאפייה או של המוצרים',
  samplesSoon: 'איזה יופי! אני מכינה לכם דוגמאות',
};

e2eTest('a new owner onboards through the agent: batch A by code, two model steps for the whole profile, brand assets and a correction, then activation', { timeout: 180_000 }, async ({ e2e }) => {
  const storage = memoryStorage();
  const messagingSim = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const publishingSim = new PublishingSimulator();
  const modelSim = new ModelSimulator();
  const paymentSim = new PaymentSimulator();
  const logo = messagingSim.addMedia('image/png', placeholderPng(400, 400, [250, 245, 235], [140, 70, 30]));
  const photo = messagingSim.addMedia('image/jpeg', new Uint8Array(await svgPhoto('challah.svg')));
  await storage.put('bundled/sample.jpg', new Uint8Array(await svgPhoto('oven.svg')), 'image/jpeg');

  // One entry per agent turn, in order. Batch A goes out by code, so no turn runs after the intro.
  modelSim.scriptAgent(
    'onboarding',
    // Batch A's answer: ONE step saves every field found in the two messages and asks the one
    // follow-up (the street); code appends batch B. The address waits, so the location is not saved yet.
    [
      step(
        call.setProfileField('name', 'מאפיית בן עמי', 'מאפיית בן עמי'),
        call.setProfileField('field', 'מאפייה שכונתית', 'מאפייה שכונתית'),
        call.setProfileField('mainProducts', ['חלות', 'בורקס', 'עוגות שמרים'], 'חלות, בורקס ועוגות שמרים'),
        call.setProfileField('location.city', 'חולון', 'אנחנו בחולון'),
        call.setProfileField('location.hours', 'א׳-ה׳ 7:00-19:00, שישי 7:00-14:00', 'פתוחים א׳-ה׳ 7:00-19:00 ושישי 7:00-14:00'),
        call.setProfileField('location.fulfillment', ['pickup'], 'רק איסוף עצמי'),
        call.askOwner(ASK.address, { topic: 'profile:location', fields: ['location'] }),
      ),
    ],
    // Batch B's answer with the follow-up: ONE step saves the rest and ends the turn; the done rule
    // passes (every field set, batch B asked in the turn before), so code moves on to brand assets.
    [
      step(
        call.setProfileField('location.address', 'רחוב הרצל 12', 'רחוב הרצל 12'),
        call.setProfileField('targetAudience', 'משפחות מהשכונה', 'משפחות מהשכונה'),
        call.setProfileField('differentiator', 'בצק שתופח 24 שעות ואפייה טרייה כל בוקר', 'הבצק שלנו תופח 24 שעות ואנחנו אופים כל בוקר מחדש'),
        call.setProfileField('channels', ['instagram', 'facebook'], 'אינסטגרם ופייסבוק'),
        call.setProfileField('schedule.publishOnShabbatAndHolidays', false, 'בשבת לא מפרסמים'),
        call.setProfileField('schedule.days', [], 'בשבת לא מפרסמים'),
        call.setProfileField('schedule.hours', [], 'בשבת לא מפרסמים'),
        call.endTurn(),
      ),
    ],
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
  let holding = false;
  let flush: () => Promise<void> = async () => {};
  let record: (turn: AgentTurnReport) => void = () => {};
  const app: AppFactory = ({ messaging: messagingProvider, publishing, model, design: recordedDesign }) => {
    const postly = createApp({
      db,
      oneShotFlows: false,
      providers: { messaging: messagingProvider, publishing, models: { google: model }, payment: paymentSim },
      design: recordedDesign!,
      media: storage,
      businessNumber: BUSINESS_PHONE,
      samplePhotoUrl: storage.urlFor('bundled/sample.jpg'),
      onAgentTurnEnd: (turn) => record(turn as AgentTurnReport),
    });
    onboarding = postly.onboarding;
    flush = () => postly.messaging.flushBursts();
    const server = buildServer({ messaging: postly.messaging, billing: postly.billing!, publicBaseUrl: 'https://postly.example.test' });
    return {
      async deliverInbound(message) {
        const hook = messagingSim.webhook(message);
        const res = await server.inject({ method: 'POST', url: WEBHOOK_PATH, headers: hook.headers, payload: hook.body });
        expect(res.statusCode).toBe(200);
        if (!holding) await postly.messaging.flushBursts();
      },
      close: async () => {
        await server.close();
        await design.close();
      },
    };
  };
  const run = await e2e.start({ providers, app, ownerPhone: OWNER, businessPhone: BUSINESS_PHONE, readMedia: storage.read });
  record = (turn) => run.recordAgentTurn(turn);

  // Sign-up creates the business; onboarding runs on the agent, as in every deployed composition.
  const businessId = await onboarding!.createBusiness({ approverPhone: OWNER });
  const said = () => run.owner.received().map((m) => m.text);
  const lastSaid = () => said().at(-1);

  // 1. The persona introduces herself (feminine Hebrew), and code sends batch A: no model call.
  await run.owner.sendsText(SAY.hello);
  expect(said()).toEqual([copy.intro('פוסטלי'), onboardingBatches.a]);
  expect(said()[0]).toContain('אני פוסטלי, סוכנת הסושיאל');
  expect(modelSim.callsFor('agent_onboarding')).toHaveLength(0);

  // 2. The owner answers batch A in two messages, one burst. One model step saves what it can and
  // asks the follow-up, and batch B comes in the same message.
  holding = true;
  await run.owner.sendsText(SAY.aboutUs);
  await run.owner.sendsText(SAY.where);
  holding = false;
  await flush();
  expect(said()).toHaveLength(3);
  expect(lastSaid()).toBe(`${ASK.address}\n\n${onboardingBatches.b}`);
  expect(modelSim.callsFor('agent_onboarding')).toHaveLength(1);

  // 3. The follow-up and batch B answered at once: one more model step, then code applies
  // PROFILE_FIELDS_COMPLETE and the agent asks for the logo.
  await run.owner.sendsText(SAY.batchB);
  expect(lastSaid()).toBe(ASK.logo);
  expect(modelSim.callsFor('agent_onboarding')).toHaveLength(3);

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
  // Six turns of one model step each: two for the whole profile (A11), three for brand assets, one correction.
  expect(stored.turns).toHaveLength(6);
  expect(modelSim.callsFor('agent_onboarding')).toHaveLength(6);
  expect(stored.turns.every((t) => t.agent === 'onboarding' && t.status !== 'failed' && t.status !== 'handed_off')).toBe(true);
  expect(run.networkPosts()).toEqual([]);
});
