/**
 * The drafts agent (WP-94; agent.md: create_draft, apply_change, Photo edits, Badge element, Fixes).
 * With the drafts flow switched to the agent for one business, a planned week is drafted on the
 * scripted agent (no real model) and rendered by the real design engine, so the report shows the posts
 * the owner would see: a single post with a straightened, cropped photo and a discount badge, and a
 * three-slide carousel in the numbered layout with a sticker. A caption that invents a price is
 * refused and corrected. Then "perfect, just add X" is a fix: the agent applies it, the owner gets a
 * new version with new buttons, the old draft's Approve tap is refused, free text never approves, and
 * only the tap on the new version does. Everything else is real: messaging, the workflow, the agent
 * runtime and its checks, the model layer, the approval service, and the database.
 */
import { eq } from 'drizzle-orm';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, expect, inject } from 'vitest';
import { createApp } from '../../src/app.js';
import { BusinessProfile } from '../../src/contracts/business-profile.js';
import type { PlannedPost } from '../../src/contracts/content.js';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { createDesignRenderer } from '../../src/modules/design/index.js';
import { draftsCopy } from '../../src/modules/workflow/index.js';
import { fixtureAssets, fixtureUrls } from '../../src/modules/design/fixtures/fixture.js';
import { MessagingSimulator, ModelSimulator, PaymentSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { call, step } from '../../src/simulators/scripted-agent.js';
import { e2eTest, type AppFactory, type E2eHarness, type Providers } from './harness/index.js';

const BUSINESS_PHONE = '+972521111194';
const OWNER = '+972501230094';
const MEDIA_ORIGIN = 'https://media.postly.test/';
const OUT = 'test-output/drafts-agent';

const UPDATE = 'השבוע 20% הנחה על כל זרי הסתיו, עד יום חמישי';
const FIX = 'מושלם, רק תוסיפי שיש משלוחים';
const CAPTION = 'מבצע על זרי הסתיו: 20% הנחה עד יום חמישי';
const FIXED = `${CAPTION}. יש משלוחים`;

const db = createDatabase(inject('databaseUrls'), { max: 4 });
afterAll(() => db.close());

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

const at = (local: string) => new Date(`${local}+02:00`);

/** The photos of the fixture set as owner photos: bytes in storage and a media_asset row each. */
async function addPhotos(storage: ReturnType<typeof memoryStorage>, businessId: string) {
  const sizes = [
    [fixtureUrls.landscape, 1600, 1200],
    [fixtureUrls.portrait, 1200, 1600],
    [fixtureUrls.square, 1500, 1500],
    [fixtureUrls.square, 1500, 1500],
  ] as const;
  const ids: string[] = [];
  for (const [i, [url, width, height]] of sizes.entries()) {
    const storagePath = `photos/${i}.svg`;
    await storage.put(storagePath, new TextEncoder().encode(fixtureAssets[url]!), 'image/svg+xml');
    const [row] = await db.withBusiness('messaging', businessId, (tx) =>
      tx.insert(schema.mediaAsset).values({ businessId, kind: 'photo', source: 'owner', storagePath, mimeType: 'image/svg+xml', width, height, sha256: `${i}`.padEnd(64, '0') }).returning({ id: schema.mediaAsset.id }),
    );
    ids.push(row!.id);
  }
  return ids;
}

const plan = (topic: string, overrides: Partial<PlannedPost>): PlannedPost => ({ topic, contentType: 'promotions', format: 'single', factIds: [], mediaAssetIds: [], brief: topic, ...overrides });

async function start(e2e: E2eHarness) {
  const clock = { now: at('2026-11-04T10:00:00') };
  const now = () => clock.now;
  const storage = memoryStorage();
  const messagingSim = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const model = new ModelSimulator();
  const providers = { messaging: messagingSim, publishing: new PublishingSimulator(), model, payment: new PaymentSimulator(), renderer: { render: async () => ({}) } } satisfies Providers;
  // The real design engine: Playwright and sharp, on the photos in storage.
  const design = createDesignRenderer({
    assets: { load: async (url) => (await storage.read(url))!.data },
    store: { put: (path, bytes, mimeType) => storage.put(path, bytes, mimeType) },
  });
  const ref: { postly?: ReturnType<typeof createApp> } = {};
  const app: AppFactory = ({ messaging, publishing, model: recorded }) => {
    ref.postly = createApp({
      db,
      providers: { messaging, publishing, models: { google: recorded } },
      design,
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
  const run = await e2e.start({ providers, app, ownerPhone: OWNER, businessPhone: BUSINESS_PHONE, readMedia: storage.read, now });
  const postly = ref.postly!;

  // An active florist whose drafts flow runs on the agent, with a planned week: two posts and their facts.
  await db.withSystem('console', (tx) => tx.update(schema.business).set({ approverPhone: `+9724${Date.now()}` }).where(eq(schema.business.approverPhone, OWNER)));
  const businessId = await postly.onboarding.createBusiness({ approverPhone: OWNER, name: 'פרחי דנה' });
  const profile = BusinessProfile.parse({
    name: 'פרחי דנה',
    field: 'חנות פרחים',
    mainProducts: ['זרי פרחים', 'עציצים'],
    location: { city: 'רמת גן', address: 'ביאליק 40', hours: 'א׳-ו׳ 9:00-19:00', fulfillment: ['pickup', 'delivery'] },
    differentiator: 'פרחים טריים מהמגדל בכל בוקר',
    channels: ['instagram'],
    style: 'warm',
    postsPerWeek: 2,
    formats: ['single', 'carousel'],
    approverPhone: OWNER,
  });
  const [a1, a2, a3, a4] = await addPhotos(storage, businessId);
  const weekId = crypto.randomUUID();
  await db.withSystem('console', async (tx) => {
    await tx.update(schema.business).set({ status: 'active', profile, style: 'warm', agentFlows: { drafts: true } }).where(eq(schema.business.id, businessId));
    await tx.update(schema.conversationState).set({ step: 'processing_update' }).where(eq(schema.conversationState.businessId, businessId));
  });
  await db.withBusiness('workflow', businessId, async (tx) => {
    await tx.insert(schema.weeklyUpdate).values({
      id: weekId,
      businessId,
      weekStart: '2026-11-01',
      status: 'planned',
      originalText: UPDATE,
      extractedFacts: {
        facts: [
          { id: 'f1', type: 'discount_percent', value: '20', sourceQuote: '20% הנחה' },
          { id: 'f2', type: 'date', value: 'עד יום חמישי', sourceQuote: 'עד יום חמישי' },
        ],
      },
      receivedAt: at('2026-11-04T09:30:00'),
    });
  });
  const planned = [
    plan('מבצע זרי סתיו', { factIds: ['f1', 'f2'], mediaAssetIds: [a1!] }),
    plan('שלושה זרים חדשים', { format: 'carousel', mediaAssetIds: [a2!, a3!, a4!] }),
  ];
  const posts = await db.withBusiness('workflow', businessId, (tx) =>
    tx.insert(schema.post).values(planned.map((p, position) => ({ businessId, weeklyUpdateId: weekId, position, format: p.format, plan: p }))).returning({ id: schema.post.id }),
  );
  await db.withBusiness('messaging', businessId, (tx) =>
    tx.insert(schema.message).values({ businessId, direction: 'inbound', kind: 'text', provider: 'sim', providerMessageId: crypto.randomUUID(), fromPhone: OWNER, toPhone: BUSINESS_PHONE, body: UPDATE, createdAt: at('2026-11-04T09:30:00') }),
  );
  return { run, postly, model, businessId, weekId, storage, photos: [a1!, a2!, a3!, a4!], posts: posts.map((p) => p.id), design, clock };
}

e2eTest(
  'the drafts agent drafts a straightened, cropped photo with a badge and a numbered carousel, applies "just add X", and only the tap on the new version approves',
  { timeout: 180_000 },
  async ({ e2e }) => {
    const { run, postly, model, businessId, weekId, storage, photos, posts, design } = await start(e2e);
    const [p1, p2] = posts as [string, string];
    const [a1, a2, a3, a4] = photos as [string, string, string, string];
    const state = async () => (await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.conversationState)))[0]!;
    const postRow = async (id: string) => (await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.post).where(eq(schema.post.id, id))))[0]!;
    const versions = (id: string) => db.withBusiness('content', businessId, (tx) => tx.select().from(schema.postVersion).where(eq(schema.postVersion.postId, id)).orderBy(schema.postVersion.versionNumber));
    try {
      // A fixed object, not a function: the simulator reads a function fixture's input as the task input, and an image call has only a URL.
      model.setDefault('image_review', { usable: true, score: 0.9, issues: [], description: 'זר סתיו על שולחן עץ', rotateDeg: -2, crop: { x: 0.1, y: 0.05, w: 0.8, h: 0.9 }, brightness: 0.1 });
      model.script('intent_detection', { intent: 'other', confidence: 0.9 }, { intent: 'change_request', confidence: 0.93 });

      const single = (text: string) => ({
        instagram: { text, hashtags: ['#פרחים'] },
      });
      const design1 = {
        photos: [{ assetId: a1, crop: { x: 0.1, y: 0.05, w: 0.8, h: 0.9 }, rotateDeg: -2, brightness: 0.1 }],
        title: '20% הנחה על זרי הסתיו',
        badge: { kind: 'discount' as const, text: '-20%', factId: 'f1' },
      };
      const design2 = {
        photos: [{ assetId: a2 }, { assetId: a3 }, { assetId: a4 }],
        title: 'שלושה זרים חדשים',
        carouselLayout: 'numbered' as const,
        badge: { kind: 'new' as const },
      };
      model.scriptAgent(
        'drafts',
        // Turn 1, after the plan is stored: the first caption invents a price, so it is refused and the
        // second call of the step is skipped; the next step corrects it and drafts both posts.
        [
          step(
            call.createDraft({ postId: p1, captions: single('זרי הסתיו ב-25 ₪ בלבד'), usedFactIds: ['f1'], design: design1 }),
            call.createDraft({ postId: p2, captions: single('שלושה זרים חדשים הגיעו'), usedFactIds: [], design: design2 }),
          ),
          step(
            call.createDraft({ postId: p1, captions: single(CAPTION), usedFactIds: ['f1', 'f2'], design: design1 }),
            call.createDraft({ postId: p2, captions: single('שלושה זרים חדשים הגיעו'), usedFactIds: [], design: design2 }),
          ),
        ],
        // Turn 2, on "perfect, just add X": a caption with an invented price is refused, then the fix.
        [
          step(call.applyChange({ postId: p1, ownerQuote: 'רק תוסיפי שיש משלוחים', captions: single(`${CAPTION}. משלוח ב-30 ₪`) })),
          step(call.applyChange({ postId: p1, ownerQuote: 'רק תוסיפי שיש משלוחים', captions: single(FIXED), rule: { text: 'לציין שיש משלוחים', scope: 'caption' } })),
        ],
      );

      // 1. Drafting runs on the agent: both posts reach the owner with Approve and Change buttons.
      await postly.drafts.draftWeek(businessId, weekId);
      const buttons = () => run.owner.received().filter((m) => m.kind === 'buttons');
      expect(buttons()).toHaveLength(2);
      expect((await state()).step).toBe('reviewing_drafts');
      expect((await postRow(p1)).status).toBe('awaiting_approval');
      expect((await postRow(p2)).status).toBe('awaiting_approval');
      const [v1] = await versions(p1);
      expect(v1!.designSpec).toEqual(design1);
      expect(v1!.captions).toEqual(single(CAPTION));
      const [c1] = await versions(p2);
      expect(c1!.designSpec).toEqual(design2);
      // The carousel: one render per slide, and the cover and the later slides are separate files.
      expect((c1!.renderedMedia as { instagram: string[] }).instagram).toHaveLength(3);
      // The owner is shown every slide, then the buttons: three slide messages for the carousel and an image on each pair of buttons, five in all (the counters
      // on slides 2 and 3 are measured on the page in styles/carousel.test.ts).
      expect(run.owner.received().filter((m) => m.image !== undefined)).toHaveLength(5);

      // The photo notes were written once, and the agent saw them.
      const reviewed = await db.withBusiness('workflow', businessId, (tx) => tx.select({ id: schema.mediaAsset.id, review: schema.mediaAsset.review }).from(schema.mediaAsset));
      expect(reviewed.filter((r) => r.review !== null)).toHaveLength(4);

      // 2. Free text never approves: the drafts come back with their buttons, and nothing is approved.
      await run.owner.sendsText('מאושר');
      expect((await postRow(p1)).status).toBe('awaiting_approval');
      expect(await db.withBusiness('approval', businessId, (tx) => tx.select().from(schema.approval))).toEqual([]);

      // 3. "Perfect, just add X" is a fix: the agent applies it (after one refused caption), the owner
      // gets a new version with new buttons, and the rule is saved.
      await run.owner.sendsText(FIX);
      const afterFix = await versions(p1);
      expect(afterFix).toHaveLength(2);
      expect(afterFix[1]!.captions).toEqual(single(FIXED));
      expect(afterFix[1]!.contentHash).not.toBe(afterFix[0]!.contentHash);
      expect(afterFix[1]!.designSpec).toEqual(design1);
      expect((await postRow(p1)).status).toBe('awaiting_approval');
      expect((await state()).step).toBe('reviewing_drafts');
      const rules = await db.withBusiness('business_data', businessId, (tx) => tx.select().from(schema.preferenceRule));
      expect(rules.map((r) => [r.scope, r.rule])).toEqual([['caption', 'לציין שיש משלוחים']]);
      expect(buttons().length).toBeGreaterThanOrEqual(3);

      // 4. The old draft's Approve button is refused; the new version's tap approves, and only it.
      await run.owner.tapsButton(draftsCopy.APPROVE_TITLE, { action: 'approve', postId: p1, versionHash: afterFix[0]!.contentHash });
      expect((await postRow(p1)).status).toBe('awaiting_approval');
      expect(await db.withBusiness('approval', businessId, (tx) => tx.select().from(schema.approval))).toEqual([]);
      await run.owner.tapsButton(draftsCopy.APPROVE_TITLE, { action: 'approve', postId: p1, versionHash: afterFix[1]!.contentHash });
      expect((await postRow(p1)).status).toBe('approved');
      const [approval] = await db.withBusiness('approval', businessId, (tx) => tx.select().from(schema.approval));
      expect(approval).toMatchObject({ postId: p1, approvedVersionHash: afterFix[1]!.contentHash });
      expect((await postRow(p2)).status).toBe('awaiting_approval');

      // The rendered posts, for the human to look at.
      mkdirSync(OUT, { recursive: true });
      for (const [i, version] of [v1!, afterFix[1]!, c1!].entries()) {
        const media = (version.renderedMedia as { instagram: string[] }).instagram;
        const rows = await db.withBusiness('content', businessId, (tx) => tx.select().from(schema.mediaAsset));
        for (const [j, id] of media.entries()) {
          const row = rows.find((r) => r.id === id)!;
          writeFileSync(`${OUT}/${['single', 'single-fixed', 'carousel'][i]}-${j + 1}.jpg`, (await storage.read(row.storagePath))!.data);
        }
      }
    } finally {
      await design.close();
    }
  },
);
