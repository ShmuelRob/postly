/**
 * Brand assets sent early (agent.md, The onboarding agent in the flow, Early images; 2026-11-09). On
 * dev an owner sent the logo and two photos while still in profile_questions, after the agent had asked
 * for the logo there. The images were never stored, PROFILE_FIELDS_COMPLETE cleared the open question,
 * and every brand-assets turn asked again until the owner was handed off. This test replays that
 * sequence on the scripted agent (no real model): the early request_photo is refused, the three images
 * are kept, and when the profile questions end code carries them into brand_assets (the first is the
 * logo, the rest are the business photos), finishes brand_assets at once and sends the style samples
 * rendered from them. Copy is provisional (H6), the prompt is provisional (H7).
 */
import { asc, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, expect, inject } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AgentTurnReport } from '../../src/simulators/scripted-agent.js';
import { call, step } from '../../src/simulators/scripted-agent.js';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { createDesignRenderer } from '../../src/modules/design/index.js';
import { WEBHOOK_PATH } from '../../src/modules/messaging/index.js';
import { onboardingCopy as copy } from '../../src/modules/workflow/index.js';
import { buildServer } from '../../src/server.js';
import { MessagingSimulator, ModelSimulator, PaymentSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { e2eTest, placeholderPng, type AppFactory, type Providers } from './harness/index.js';

const OWNER = '+972501230094';
const BUSINESS_PHONE = '+972521111194';
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

const SAY = {
  hello: 'היי, נרשמתי לפוסטלי',
  business:
    'קוראים לנו מאפיית בן עמי, מאפייה שכונתית. אנחנו אופים חלות, בורקס ועוגות שמרים. ' +
    'אנחנו בחולון, רחוב הרצל 12. פתוחים א׳-ה׳ 7:00-19:00 ושישי 7:00-14:00. רק איסוף עצמי. ' +
    'הבצק שלנו תופח 24 שעות ואנחנו אופים כל בוקר מחדש',
  channels: 'אינסטגרם ופייסבוק',
  nothingElse: 'לא, זה הכול',
};
const ASK = {
  business: 'נעים מאוד! ספרו לי על העסק: מה אתם מוכרים, איפה אתם ומה מייחד אתכם?',
  logoEarly: 'יש לכם לוגו? שלחו אותו כאן כתמונה',
  channels: 'באילו רשתות לפרסם: אינסטגרם, פייסבוק או שתיהן?',
  gotLogo: 'קיבלתי, תודה! אשתמש בזה בעיצובים',
  gotPhoto: 'איזו תמונה יפה, שמרתי אותה',
  anythingElse: 'יש עוד משהו שחשוב שהלקוחות ידעו?',
};

e2eTest('an owner who sends the logo and photos during the profile questions still reaches the style samples, built from them', { timeout: 180_000 }, async ({ e2e }) => {
  const storage = memoryStorage();
  const messagingSim = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const modelSim = new ModelSimulator({ strictAgents: true });
  const logo = messagingSim.addMedia('image/png', placeholderPng(400, 400, [250, 245, 235], [140, 70, 30]));
  const challah = messagingSim.addMedia('image/jpeg', new Uint8Array(await svgPhoto('challah.svg')));
  const oven = messagingSim.addMedia('image/jpeg', new Uint8Array(await svgPhoto('oven.svg')));
  await storage.put('bundled/sample.jpg', new Uint8Array(await svgPhoto('oven.svg')), 'image/jpeg');

  // One entry per agent turn, in order. There is no brand-assets turn: the early images answer both requests.
  modelSim.scriptAgent(
    'onboarding',
    [step(call.askOwner(ASK.business, { topic: 'profile:name' }))],
    // Every field but the channels; then, as on dev, the agent asks for the logo too early: refused
    // (not offered in profile_questions), and its next step asks the channels question instead.
    [
      step(
        call.setProfileField('name', 'מאפיית בן עמי', 'מאפיית בן עמי'),
        call.setProfileField('field', 'מאפייה שכונתית', 'מאפייה שכונתית'),
        call.setProfileField('mainProducts', ['חלות', 'בורקס', 'עוגות שמרים'], 'חלות, בורקס ועוגות שמרים'),
        call.setProfileField('location.city', 'חולון', 'בחולון'),
        call.setProfileField('location.address', 'רחוב הרצל 12', 'רחוב הרצל 12'),
        call.setProfileField('location.hours', 'א׳-ה׳ 7:00-19:00, שישי 7:00-14:00', 'פתוחים א׳-ה׳ 7:00-19:00 ושישי 7:00-14:00'),
        call.setProfileField('location.fulfillment', ['pickup'], 'רק איסוף עצמי'),
        call.setProfileField('differentiator', 'בצק שתופח 24 שעות ואפייה טרייה כל בוקר', 'הבצק שלנו תופח 24 שעות ואנחנו אופים כל בוקר מחדש'),
      ),
      step(call.requestPhoto('logo', ASK.logoEarly)),
      step(call.askOwner(ASK.channels, { topic: 'profile:channels' })),
    ],
    // Three images while still in profile_questions: the agent only acknowledges each.
    [step(call.askOwner(ASK.gotLogo, { expects: 'none' }), call.endTurn())],
    [step(call.askOwner(ASK.gotPhoto, { expects: 'none' }), call.endTurn())],
    [step(call.askOwner(ASK.gotPhoto, { expects: 'none' }), call.endTurn())],
    [step(call.setProfileField('channels', ['instagram', 'facebook'])), step(call.askOwner(ASK.anythingElse, { topic: 'anything_else' }))],
    // The closing answer: done, so code applies PROFILE_FIELDS_COMPLETE and carries the images in.
    [step(call.endTurn())],
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
  const paymentSim = new PaymentSimulator();
  const providers = { messaging: messagingSim, publishing: new PublishingSimulator(), model: modelSim, payment: paymentSim, renderer: { render: async () => ({}) }, design } satisfies Providers;
  await db.withSystem('console', (tx) => tx.update(schema.business).set({ approverPhone: `+9720${Date.now()}4` }).where(eq(schema.business.approverPhone, OWNER)));

  let onboarding: ReturnType<typeof createApp>['onboarding'] | undefined;
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

  const businessId = await onboarding!.createBusiness({ approverPhone: OWNER });
  const said = () => run.owner.received().map((m) => m.text);
  const state = () =>
    db.withBusiness('workflow', businessId, async (tx) => ({
      business: (await tx.select().from(schema.business))[0]!,
      conversation: (await tx.select().from(schema.conversationState))[0]!,
    }));

  // 1. The intro and the first question; the owner answers almost everything at once.
  await run.owner.sendsText(SAY.hello);
  await run.owner.sendsText(SAY.business);
  // The early logo request never reached the owner; the channels question did.
  expect(said()).toEqual([copy.intro('פוסטלי'), ASK.business, ASK.channels]);

  // 2. Still in profile_questions, the owner sends the logo and two photos, one by one.
  await run.owner.sendsImage(logo);
  await run.owner.sendsImage(challah, 'החלות שלנו');
  await run.owner.sendsImage(oven);
  expect(said().slice(-3)).toEqual([ASK.gotLogo, ASK.gotPhoto, ASK.gotPhoto]);
  const images = await db.withBusiness('messaging', businessId, (tx) =>
    tx.select({ kind: schema.message.kind, mediaAssetIds: schema.message.mediaAssetIds }).from(schema.message).where(eq(schema.message.direction, 'inbound')).orderBy(asc(schema.message.createdAt)),
  );
  const [logoId, challahId, ovenId] = images.filter((m) => m.kind === 'image').flatMap((m) => m.mediaAssetIds);
  // They are kept as pending assets while the questions go on.
  const pending = await state();
  expect(pending.conversation.step).toBe('profile_questions');
  expect(pending.conversation.openQuestion).toMatchObject({ photoAssetIds: [logoId, challahId, ovenId] });

  // 3. The last answers: the profile questions end, and the early images answer both brand requests,
  //    so code sends the style samples at once, with no new request for the logo or photos.
  await run.owner.sendsText(SAY.channels);
  expect(said().at(-1)).toBe(ASK.anythingElse);
  await run.owner.sendsText(SAY.nothingElse);
  const samples = run.owner.received().slice(-5);
  expect(samples.map((m) => m.text)).toEqual([copy.samplesIntro, copy.sampleCaption.clean, copy.sampleCaption.warm, copy.sampleCaption.dynamic, copy.chooseStyle]);
  expect(samples.slice(1, 4).every((m) => m.image !== undefined)).toBe(true);

  // The first image is the logo and the others are the business photos; the samples use the first photo.
  const after = await state();
  expect(after.conversation.step).toBe('style_selection');
  expect(after.business.profile).toMatchObject({ brand: { logoAssetId: logoId } });
  expect(after.conversation.openQuestion).toMatchObject({ key: 'style', photoAssetIds: [challahId, ovenId] });
  const turns = await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.agentTurn));
  expect(turns).toHaveLength(7);
  expect(turns.every((t) => t.status !== 'failed' && t.status !== 'handed_off')).toBe(true);
  expect(after.conversation.handoffAt).toBeNull();

  // 4. The style choice goes on to the summary, as usual.
  await run.owner.sendsText('1');
  expect(said().at(-1)).toContain('• סגנון:');
  expect(run.networkPosts()).toEqual([]);
});
