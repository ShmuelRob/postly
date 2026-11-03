/**
 * H5 human-owned end-to-end tests: what the owner and the publishing simulator see around approval.
 * Written from the docs before WP-33/WP-34; pending until both flip `test/h5/pending.ts`.
 */
import { expect, inject } from 'vitest';
import type { ModelProvider, PaymentProvider, TemplateRenderer } from '../../src/contracts/providers/index.js';
import { MessagingSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { openH5Db } from '../h5/db.js';
import { APPROVER, SCHEDULED_FOR, STRANGER } from '../h5/fixtures.js';
import { H5_PENDING } from '../h5/pending.js';
import { createH5World, type H5World } from '../h5/world.js';
import { e2eTest } from './harness/index.js';

const BUSINESS_PHONE = '+972501234562';
const pending = H5_PENDING.approval || H5_PENDING.publishing;
const h5e2e = (pending ? e2eTest.fails : e2eTest) as typeof e2eTest;

const notUsed = (what: string) => () => Promise.reject(new Error(`${what} is not used in this test`));
const model: ModelProvider = { name: 'unused', generateStructured: notUsed('model'), analyzeImage: notUsed('model'), transcribeAudio: notUsed('model') };
const payment: PaymentProvider = { name: 'unused', createPaymentLink: notUsed('payment'), getSubscriptionStatus: notUsed('payment'), cancelSubscription: notUsed('payment') };
const renderer: TemplateRenderer = { render: notUsed('renderer') };

h5e2e('H5 e2e: free text and stale buttons never publish; only the approver tapping the current version does', async ({ e2e }) => {
  let now = new Date('2026-11-03T08:00:00.000Z');
  const clock = () => now;
  const publishing = new PublishingSimulator({ now: clock });
  const db = openH5Db();
  let world: H5World | undefined;
  const run = await e2e.start({
    providers: { messaging: new MessagingSimulator(), publishing, model, payment, renderer },
    app: async (p) => {
      world = await createH5World({ messaging: p.messaging, publishing: p.publishing, now: clock, databaseUrls: inject('databaseUrls') });
      return world.app;
    },
    ownerPhone: APPROVER,
    businessPhone: BUSINESS_PHONE,
    now: clock,
  });
  if (!world) {
    await db.close();
    throw new Error('world not created');
  }
  try {
    const businessId = await world.createBusiness(APPROVER);
    await world.connectChannel(businessId, 'instagram');
    await world.connectChannel(businessId, 'facebook');
    const first = await world.createDraft(businessId, 'צבעונים חדשים הגיעו, 25 ₪ לזר');
    expect(run.owner.received().at(-1)?.buttons?.map((b) => b.title)).toEqual([first.buttons.approve, first.buttons.change]);

    for (const text of ['מאשר', 'אישור', 'ok', '👍']) await run.owner.sendsText(text);
    expect(await db.postStatus(first.postId)).toBe('awaiting_approval');
    expect(await db.approvals(first.postId)).toEqual([]);
    // PRD: free text is not approval, so the owner is shown the approve button again.
    expect(run.owner.received().at(-1)?.buttons?.map((b) => b.title)).toContain(first.buttons.approve);

    const second = await world.requestChange(businessId, first.postId, 'צבעונים חדשים הגיעו, 30 ₪ לזר');
    await run.owner.tapsButton(first.buttons.approve, { action: 'approve', postId: first.postId, versionHash: first.versionHash });
    expect(await db.postStatus(first.postId)).toBe('awaiting_approval');

    await run.owner.tapsButton(second.buttons.approve, { action: 'approve', postId: second.postId, versionHash: second.versionHash });
    expect(await db.postStatus(first.postId)).toBe('approved');

    const publications = await world.schedule(businessId, first.postId, SCHEDULED_FOR);
    expect(run.networkPosts()).toEqual([]);
    now = new Date('2026-11-04T08:01:00.000Z');
    for (const { publicationId } of publications) await world.publishingJob.runPublication(publicationId);

    expect(run.networkPosts().map((p) => p.network).sort()).toEqual(['facebook', 'instagram']);
    for (const post of run.networkPosts()) {
      expect(post.caption).toBe('צבעונים חדשים הגיעו, 30 ₪ לזר');
      expect(post.outcome.ok).toBe(true);
    }
  } finally {
    await world.close();
    await db.close();
  }
});

h5e2e('H5 e2e: a stranger tapping approve publishes nothing, and a pause holds an approved post', async ({ e2e }) => {
  let now = new Date('2026-11-03T08:00:00.000Z');
  const clock = () => now;
  const messaging = new MessagingSimulator();
  const publishing = new PublishingSimulator({ now: clock });
  const db = openH5Db();
  let world: H5World | undefined;
  const run = await e2e.start({
    providers: { messaging, publishing, model, payment, renderer },
    app: async (p) => {
      world = await createH5World({ messaging: p.messaging, publishing: p.publishing, now: clock, databaseUrls: inject('databaseUrls') });
      return world.app;
    },
    ownerPhone: APPROVER,
    businessPhone: BUSINESS_PHONE,
    now: clock,
  });
  if (!world) {
    await db.close();
    throw new Error('world not created');
  }
  try {
    const businessId = await world.createBusiness(APPROVER);
    await world.connectChannel(businessId, 'instagram');
    const draft = await world.createDraft(businessId, 'מבצע סוף שבוע: 20% הנחה');

    await world.app.deliverInbound(
      messaging.inboundButtonTap(STRANGER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash }),
    );
    expect(await db.postStatus(draft.postId)).toBe('awaiting_approval');

    await run.owner.tapsButton(draft.buttons.approve, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });
    const publications = await world.schedule(businessId, draft.postId, SCHEDULED_FOR);
    now = new Date('2026-11-04T08:01:00.000Z');
    await db.setBusinessPaused(businessId, true);
    for (const { publicationId } of publications) await world.publishingJob.runPublication(publicationId);
    expect(run.networkPosts()).toEqual([]);

    await db.setBusinessPaused(businessId, false);
    for (const { publicationId } of publications) await world.publishingJob.runPublication(publicationId);
    expect(run.networkPosts().map((p) => p.caption)).toEqual(['מבצע סוף שבוע: 20% הנחה']);
  } finally {
    await world.close();
    await db.close();
  }
});

