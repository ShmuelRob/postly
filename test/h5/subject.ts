import { and, eq, sql } from 'drizzle-orm';
import { createApp, type App } from '../../src/app.js';
import { BusinessProfile } from '../../src/contracts/business-profile.js';
import type { Network } from '../../src/contracts/common.js';
import type { Fact } from '../../src/contracts/model-tasks.js';
import type { InboundMessage } from '../../src/contracts/providers/messaging.js';
import type { RenderResult } from '../../src/contracts/providers/renderer.js';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { createChannels } from '../../src/modules/publishing/index.js';
import { draftsCopy } from '../../src/modules/workflow/index.js';
import { ModelSimulator, PaymentSimulator } from '../../src/simulators/index.js';
import { holdSharedDatabaseLock } from '../db/shared-lock.js';
import { placeholderPng } from '../e2e/harness/png.js';
import type { Draft, H5World, H5WorldFactory } from './world.js';

const apps = new WeakMap<H5World, App>();
const extras = new WeakMap<H5World, { payment: PaymentSimulator; files: Map<string, Uint8Array> }>();

/** The real app behind a world, for tests outside the pinned H5 files that need more than the world's surface (WP-35). */
export function subjectApp(world: H5World): App {
  const app = apps.get(world);
  if (!app) throw new Error('not a subject world');
  return app;
}

/** The world's payment simulator and stored files (WP-43: cancellation and data deletion). */
export function subjectExtras(world: H5World): { payment: PaymentSimulator; files: Map<string, Uint8Array> } {
  const found = extras.get(world);
  if (!found) throw new Error('not a subject world');
  return found;
}

/**
 * WP-33 and WP-34 bind the real world here, with the real approval service and publishing job. Setup goes through the real
 * app: onboarding creates the business, the publishing module verifies channels, drafts writes,
 * fact-checks, versions and sends each draft, a change goes in as the owner's Change tap and text,
 * scheduling creates the publications. Only what a setup needs and no flow provides is written
 * directly: the active profile, the week's facts and plan, and an owner message that opens the
 * 24-hour window. The renderer stores a placeholder image and the model is the simulator.
 *
 * The H5 files all use the same approver numbers and `business.approver_phone` is unique, so one
 * world at a time holds a database advisory lock, across test files and processes.
 */

const MEDIA_ORIGIN = 'https://media.h5.test/';

/** Price and discount facts for every price and percent in the caption, so the code fact check passes. */
function factsFor(caption: string): Fact[] {
  const facts: Fact[] = [];
  for (const m of caption.matchAll(/(\d+)\s*₪/gu)) facts.push({ id: `price_${m[1]}`, type: 'price', value: m[0], sourceQuote: m[0] });
  for (const m of caption.matchAll(/(\d+)%/gu)) facts.push({ id: `discount_${m[1]}`, type: 'discount_percent', value: m[0], sourceQuote: m[0] });
  return facts;
}

export const createH5World: H5WorldFactory = async ({ messaging, publishing, now, databaseUrls }) => {
  const db = createDatabase(databaseUrls, { max: 4 });

  // Held until close(); the same lock other e2e tests take around global state (test/db/shared-lock.ts).
  const release = await holdSharedDatabaseLock(db);

  const files = new Map<string, Uint8Array>();
  const model = new ModelSimulator();
  const payment = new PaymentSimulator({ now });
  /** The caption the next caption_writing call returns (one world runs at a time). */
  let nextCaption = 'פוסט';
  model.setDefault('caption_writing', (input) => {
    const text = nextCaption;
    const caption = { text, hashtags: [] };
    return {
      captions: Object.fromEntries(input.networks.map((n) => [n, caption])),
      usedFactIds: input.plan.factIds.filter((id) => factsFor(text).some((f) => f.id === id)),
    } as never;
  });

  const app = createApp({
    db,
    providers: { messaging, publishing, models: { google: model }, payment },
    design: {
      forBusiness: ({ storagePrefix }) => ({
        async render(request) {
          const result: RenderResult = {};
          for (const network of request.networks) {
            const storagePath = `${storagePrefix}/${network}-${files.size}.png`;
            files.set(storagePath, placeholderPng(64, 64, [240, 230, 220], network === 'instagram' ? [200, 80, 120] : [60, 90, 200]));
            result[network] = [{ storagePath, width: 64, height: 64, mimeType: 'image/png' }];
          }
          return result;
        },
      }),
    },
    media: {
      put: async (path, bytes) => void files.set(path, bytes),
      urlFor: (path) => MEDIA_ORIGIN + path,
      read: async (ref) => {
        const data = files.get(ref.startsWith(MEDIA_ORIGIN) ? ref.slice(MEDIA_ORIGIN.length) : ref);
        return data && { data };
      },
      removePrefix: async (prefix) => {
        for (const path of [...files.keys()]) if (path.startsWith(prefix)) files.delete(path);
      },
      remove: async (paths) => {
        for (const path of paths) files.delete(path);
      },
    },
    businessNumber: '+972501234560',
    samplePhotoUrl: `${MEDIA_ORIGIN}sample.png`,
    burstQuietMs: 0,
    now,
  });

  const phones = new Map<string, string>();

  /** `approver_phone` is unique: a business holding the number (from an earlier world) gets another one. */
  const freeNumber = (phone: string) =>
    db.withSystem('console', (tx) =>
      tx
        .update(schema.business)
        .set({ approverPhone: `+9725${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}` })
        .where(eq(schema.business.approverPhone, phone)),
    );
  const weeks = new Map<string, string>();

  async function current(businessId: string, postId: string): Promise<Draft> {
    const [row] = await db.withBusiness('content', businessId, (tx) =>
      tx
        .select({ hash: schema.postVersion.contentHash })
        .from(schema.post)
        .innerJoin(schema.postVersion, eq(schema.postVersion.id, schema.post.currentVersionId))
        .where(eq(schema.post.id, postId)),
    );
    if (!row) throw new Error(`post ${postId} has no current version`);
    return { postId, versionHash: row.hash, buttons: { approve: draftsCopy.APPROVE_TITLE, change: draftsCopy.CHANGE_TITLE } };
  }

  async function status(businessId: string, postId: string) {
    const [row] = await db.withBusiness('workflow', businessId, (tx) => tx.select({ s: schema.post.status }).from(schema.post).where(eq(schema.post.id, postId)));
    return row?.s;
  }

  async function deliver(message: InboundMessage) {
    await app.messaging.receive(message);
    await app.messaging.flushBursts();
  }

  /** An inbound message as the provider would send it, at the shared clock. */
  const inbound = (from: string, content: InboundMessage['content']): InboundMessage => ({
    provider: messaging.name,
    providerMessageId: `h5-${crypto.randomUUID()}`,
    from,
    to: '+972501234560',
    receivedAt: now().toISOString(),
    content,
  });

  const world: H5World = {
    approval: app.approvals,
    publishingJob: app.publishing,
    app: {
      deliverInbound: deliver,
      close: () => app.messaging.close(),
    },

    async createBusiness(approverPhone) {
      await freeNumber(approverPhone);
      const businessId = await app.onboarding.createBusiness({ approverPhone, name: 'פרחי השכונה' });
      const profile = BusinessProfile.parse({
        name: 'פרחי השכונה',
        field: 'חנות פרחים',
        mainProducts: ['זרים', 'צבעונים'],
        location: { city: 'חיפה', address: 'רחוב הנביאים 5', hours: 'א׳-ו׳ 8:00-18:00', fulfillment: ['pickup'] },
        differentiator: 'פרחים טריים כל בוקר',
        channels: ['instagram', 'facebook'],
        style: 'clean',
        postsPerWeek: 2,
        contact: { phone: '+97248000000' },
        approverPhone,
      });
      await db.withSystem('console', async (tx) => {
        await tx.update(schema.business).set({ status: 'active', profile, style: 'clean' }).where(eq(schema.business.id, businessId));
        await tx.update(schema.conversationState).set({ step: 'idle' }).where(eq(schema.conversationState.businessId, businessId));
      });
      // The owner wrote today, so the 24-hour window is open for the drafts.
      await app.messaging.record(businessId, inbound(approverPhone, { kind: 'text', text: 'היי' }));
      phones.set(businessId, approverPhone);
      return businessId;
    },

    async connectChannel(businessId, network: Network) {
      const sim = publishing as unknown as { connect?: (businessId: string, network: Network) => string };
      if (!sim.connect) throw new Error('connectChannel needs the publishing simulator itself');
      const channels = createChannels({ db, provider: publishing, apply: (b, r) => app.workflow.apply(b, r), now });
      await channels.requestLink(businessId, [network]);
      sim.connect(businessId, network);
      const result = await channels.checkAndTest(businessId);
      if (result.find((c) => c.network === network)?.status !== 'verified') throw new Error(`${network} was not verified`);
    },

    async createDraft(businessId, caption) {
      nextCaption = caption;
      const facts = factsFor(caption);
      // An active business's chosen channels are the ones it verified (onboarding verifies every
      // chosen channel), so the draft targets exactly the connected networks.
      await db.withSystem('console', async (tx) => {
        const verified = await tx
          .select({ network: schema.channelConnection.network })
          .from(schema.channelConnection)
          .where(and(eq(schema.channelConnection.businessId, businessId), eq(schema.channelConnection.status, 'verified')));
        if (verified.length === 0) return;
        const [row] = await tx.select({ profile: schema.business.profile }).from(schema.business).where(eq(schema.business.id, businessId));
        const chosen = BusinessProfile.parse(row!.profile).channels;
        const channels = chosen.filter((n) => verified.some((v) => v.network === n));
        if (channels.length === 0) return;
        const profile = BusinessProfile.parse({ ...(row!.profile as object), channels });
        await tx.update(schema.business).set({ profile }).where(eq(schema.business.id, businessId));
      });
      const postId = await db.withBusiness('workflow', businessId, async (tx) => {
        let weekId = weeks.get(businessId);
        if (!weekId) {
          const [week] = await tx
            .insert(schema.weeklyUpdate)
            .values({ businessId, weekStart: '2026-11-01', status: 'planned', originalText: caption, extractedFacts: { facts, missingDetails: [] }, receivedAt: now() })
            .returning({ id: schema.weeklyUpdate.id });
          weekId = week!.id;
          weeks.set(businessId, weekId);
        } else {
          const [week] = await tx.select().from(schema.weeklyUpdate).where(eq(schema.weeklyUpdate.id, weekId));
          const known = ((week?.extractedFacts as { facts?: Fact[] } | null)?.facts ?? []) as Fact[];
          const merged = [...known, ...facts.filter((f) => !known.some((k) => k.id === f.id))];
          await tx.update(schema.weeklyUpdate).set({ extractedFacts: { facts: merged, missingDetails: [] } }).where(eq(schema.weeklyUpdate.id, weekId));
        }
        const [last] = await tx.select({ n: sql<number>`coalesce(max(${schema.post.position}), 0)` }).from(schema.post).where(eq(schema.post.weeklyUpdateId, weekId));
        const [post] = await tx
          .insert(schema.post)
          .values({
            businessId,
            weeklyUpdateId: weekId,
            position: Number(last?.n ?? 0) + 1,
            format: 'single',
            plan: { topic: caption.slice(0, 30), contentType: 'products', format: 'single', factIds: facts.map((f) => f.id), mediaAssetIds: [], brief: caption },
          })
          .returning({ id: schema.post.id });
        await tx.update(schema.conversationState).set({ step: 'processing_update' }).where(eq(schema.conversationState.businessId, businessId));
        return post!.id;
      });
      await app.drafts.draftWeek(businessId, weeks.get(businessId)!);
      if ((await status(businessId, postId)) !== 'awaiting_approval') throw new Error(`setup: draft ${postId} was not sent`);
      return current(businessId, postId);
    },

    async requestChange(businessId, postId, newCaption) {
      const before = await current(businessId, postId);
      const facts = factsFor(newCaption);
      // The owner's change names the new price, so it becomes a fact of the week and of the plan.
      await db.withBusiness('workflow', businessId, async (tx) => {
        const weekId = weeks.get(businessId)!;
        const [week] = await tx.select().from(schema.weeklyUpdate).where(eq(schema.weeklyUpdate.id, weekId));
        const known = ((week?.extractedFacts as { facts?: Fact[] } | null)?.facts ?? []) as Fact[];
        await tx
          .update(schema.weeklyUpdate)
          .set({ extractedFacts: { facts: [...known, ...facts.filter((f) => !known.some((k) => k.id === f.id))], missingDetails: [] } })
          .where(eq(schema.weeklyUpdate.id, weekId));
        const [post] = await tx.select().from(schema.post).where(eq(schema.post.id, postId));
        const plan = post!.plan as { factIds: string[] };
        await tx
          .update(schema.post)
          .set({ plan: { ...plan, factIds: [...new Set([...plan.factIds, ...facts.map((f) => f.id)])] } })
          .where(and(eq(schema.post.id, postId), eq(schema.post.businessId, businessId)));
      });
      nextCaption = newCaption;
      model.script('intent_detection', { intent: 'change_request', confidence: 0.9 });
      model.script('change_interpretation', { changes: [{ target: 'caption', instruction: newCaption }] } as never);
      const phone = phones.get(businessId)!;
      await deliver(inbound(phone, { kind: 'button_reply', buttonId: `change:${postId}:${before.versionHash}`, payload: { action: 'change', postId, versionHash: before.versionHash } }));
      await deliver(inbound(phone, { kind: 'text', text: newCaption }));
      const after = await current(businessId, postId);
      if (after.versionHash === before.versionHash) throw new Error('setup: the change produced no new version');
      return after;
    },

    async schedule(businessId, postId, scheduledFor) {
      return app.scheduling.schedule(businessId, postId, new Date(scheduledFor));
    },

    async cancelPost(businessId, postId) {
      const result = await app.workflow.apply(businessId, { machine: 'post', id: postId, event: 'CANCELLED', source: 'console' });
      if (!result.ok) throw new Error(`setup: cancel refused (${result.reason})`);
      await app.scheduling.cancelPending(businessId, postId);
    },

    async close() {
      try {
        await app.messaging.close();
        // Leave no business holding the shared numbers for tests outside the H5 lock.
        for (const phone of new Set(phones.values())) await freeNumber(phone);
      } finally {
        await release();
        await db.close();
      }
    },
  };
  apps.set(world, app);
  extras.set(world, { payment, files });
  return world;
};
