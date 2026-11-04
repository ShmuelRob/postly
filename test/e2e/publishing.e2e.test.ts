/**
 * Scheduling and publishing (WP-34; PRD Approval and publishing; state-machines.md, Publishing guard
 * and Publication; technical-design.md, Scheduling and publishing flow). The owner approves a draft
 * with its button, Postly proposes a time, the owner confirms it, and the publishing job publishes it
 * on both simulated networks at that time, then sends the confirmation template. A draft that was not
 * approved, or changed after confirmation, never reaches the networks. The app is real (the H5 world
 * in test/h5/subject.ts wires it on the simulators, with a placeholder renderer); copy is provisional.
 */
import { eq } from 'drizzle-orm';
import { expect, inject } from 'vitest';
import type { ModelProvider, PaymentProvider, TemplateRenderer } from '../../src/contracts/providers/index.js';
import * as schema from '../../src/db/schema.js';
import type { Publishing } from '../../src/modules/publishing/index.js';
import { scheduleCopy } from '../../src/modules/workflow/index.js';
import { MessagingSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { openH5Db, type H5Db } from '../h5/db.js';
import { createH5World, type H5World } from '../h5/world.js';
import { e2eTest, type E2eHarness, type E2eRun } from './harness/index.js';

const OWNER = '+972501233311';
const BUSINESS_PHONE = '+972501234560';
const CAPTION = 'צבעונים חדשים הגיעו, 25 ₪ לזר';
const CHANGED = 'צבעונים חדשים הגיעו, 30 ₪ לזר';
// Tuesday 2026-11-03 10:00 in Israel. The first proposed time is Wednesday 10:00 (08:00Z).
const START = '2026-11-03T08:00:00.000Z';
const PROPOSED = '2026-11-04T08:00:00.000Z';

const notUsed = (what: string) => () => Promise.reject(new Error(`${what} is not used in this test`));
const model: ModelProvider = { name: 'unused', generateStructured: notUsed('model'), analyzeImage: notUsed('model'), transcribeAudio: notUsed('model') };
const payment: PaymentProvider = { name: 'unused', createPaymentLink: notUsed('payment'), getSubscriptionStatus: notUsed('payment'), cancelSubscription: notUsed('payment') };
const renderer: TemplateRenderer = { render: notUsed('renderer') };

interface Ctx {
  run: E2eRun;
  world: H5World;
  db: H5Db;
  publishing: PublishingSimulator;
  job: Publishing;
  businessId: string;
  setNow(iso: string): void;
}

/** An active business with Instagram and Facebook verified, then `body`. */
async function withBusiness(e2e: E2eHarness, body: (ctx: Ctx) => Promise<void>) {
  let now = new Date(START);
  const clock = () => now;
  const publishing = new PublishingSimulator({ now: clock });
  const db = openH5Db();
  let world: H5World | undefined;
  const run = await e2e.start({
    providers: { messaging: new MessagingSimulator({ businessNumber: BUSINESS_PHONE }), publishing, model, payment, renderer },
    app: async (p) => {
      world = await createH5World({ messaging: p.messaging, publishing: p.publishing, now: clock, databaseUrls: inject('databaseUrls') });
      return world.app;
    },
    ownerPhone: OWNER,
    businessPhone: BUSINESS_PHONE,
    now: clock,
  });
  try {
    const businessId = await world!.createBusiness(OWNER);
    await world!.connectChannel(businessId, 'instagram');
    await world!.connectChannel(businessId, 'facebook');
    // The channel test validated a schedule on each account and published nothing.
    expect(publishing.scheduleTests.map((t) => t.network).sort()).toEqual(['facebook', 'instagram']);
    expect(run.networkPosts()).toEqual([]);
    const job = world!.publishingJob as Publishing;
    await body({ run, world: world!, db, publishing, job, businessId, setNow: (iso) => (now = new Date(iso)) });
  } finally {
    await world?.close();
    await db.close();
  }
}

const publications = (db: H5Db, postId: string) =>
  db.db.withSystem('console', (tx) => tx.select().from(schema.publication).where(eq(schema.publication.postId, postId)));
const consoleItems = (db: H5Db, businessId: string) =>
  db.db.withSystem('console', (tx) => tx.select().from(schema.consoleItem).where(eq(schema.consoleItem.businessId, businessId)));

const templates = (run: E2eRun) => run.owner.received().filter((m) => m.kind === 'template');

e2eTest('an approved post is proposed a time, confirmed, and published on both networks at that time; the owner gets the template', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async ({ run, world, db, job, businessId, setNow }) => {
    const draft = await world.createDraft(businessId, CAPTION);
    await run.owner.tapsButton(draft.buttons.approve, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });

    // Every draft of the week is approved, so Postly proposes the time (default: Sunday to Thursday at 10:00).
    const proposal = run.owner.received().at(-1)?.text ?? '';
    expect(proposal).toContain('אלה הזמנים שאני מציע');
    expect(proposal).toContain('יום רביעי 4.11 בשעה 10:00');

    await run.owner.sendsText('כן');
    expect(run.owner.received().at(-1)?.text).toContain('מתוזמן');
    expect(await db.postStatus(draft.postId)).toBe('scheduled');

    // Before the time nothing goes out.
    setNow('2026-11-04T07:59:00.000Z');
    expect((await job.tick(new Date('2026-11-04T07:59:00.000Z'), { businessId })).ran).toBe(0);
    expect(run.networkPosts()).toEqual([]);

    setNow('2026-11-04T08:01:00.000Z');
    expect((await job.tick(new Date('2026-11-04T08:01:00.000Z'), { businessId })).ran).toBe(2);
    expect(run.networkPosts().map((p) => p.network).sort()).toEqual(['facebook', 'instagram']);
    for (const post of run.networkPosts()) {
      expect(post.caption).toBe(CAPTION);
      expect(post.scheduledFor).toBe(PROPOSED);
      expect(post.media).toHaveLength(1);
      expect(post.outcome.ok).toBe(true);
    }
    expect(await db.postStatus(draft.postId)).toBe('published');
    expect(templates(run).map((t) => t.template)).toEqual([
      { name: scheduleCopy.PUBLISHED_TEMPLATE, language: 'he', variables: { topic: expect.any(String), networks: 'אינסטגרם ופייסבוק' } },
    ]);

    // The job never publishes the same publication twice.
    expect((await job.tick(new Date('2026-11-04T09:00:00.000Z'), { businessId })).ran).toBe(0);
    expect(run.networkPosts()).toHaveLength(2);
  });
});

e2eTest('an unapproved draft never goes live: "כן" and "מאשר" are not approvals and no time is proposed', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async ({ run, db, world, job, businessId, setNow }) => {
    const draft = await world.createDraft(businessId, CAPTION);
    for (const text of ['כן', 'מאשר']) await run.owner.sendsText(text);
    expect(await db.postStatus(draft.postId)).toBe('awaiting_approval');
    expect(run.owner.received().some((m) => m.text?.includes('אלה הזמנים שאני מציע'))).toBe(false);

    setNow('2026-11-20T08:00:00.000Z');
    expect((await job.tick(new Date('2026-11-20T08:00:00.000Z'), { businessId })).ran).toBe(0);
    expect(run.networkPosts()).toEqual([]);
    expect(templates(run)).toEqual([]);
  });
});

e2eTest('a scheduled post that the owner changes never goes live, in its old version or its new one until approved and scheduled again', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async ({ run, db, world, job, businessId, setNow }) => {
    // Two drafts this week, so approving the first proposes no times yet and drafts stay open.
    const first = await world.createDraft(businessId, CAPTION);
    await world.createDraft(businessId, 'מבצע סוף שבוע: 20% הנחה');
    await run.owner.tapsButton(first.buttons.approve, { action: 'approve', postId: first.postId, versionHash: first.versionHash });
    expect(await db.postStatus(first.postId)).toBe('approved');
    // The team schedules the approved post from the console (state-machines.md: manual scheduling still needs the approved hash).
    const scheduled = await world.schedule(businessId, first.postId, PROPOSED);
    expect(scheduled).toHaveLength(2);

    // The owner changes the price: a new version, so the approval and both publications are void.
    const changed = await world.requestChange(businessId, first.postId, CHANGED);
    expect(changed.versionHash).not.toBe(first.versionHash);
    expect(await db.postStatus(first.postId)).toBe('awaiting_approval');
    for (const p of await publications(db, first.postId)) expect(p.status).toBe('cancelled');

    setNow('2026-11-04T08:01:00.000Z');
    expect((await job.tick(new Date('2026-11-04T08:01:00.000Z'), { businessId })).ran).toBe(0);
    // The old version's button no longer approves.
    await run.owner.tapsButton(first.buttons.approve, { action: 'approve', postId: first.postId, versionHash: first.versionHash });
    expect(await db.postStatus(first.postId)).toBe('awaiting_approval');
    // Approving the new version does not make it live by itself: it needs its own confirmed time.
    await run.owner.tapsButton(changed.buttons.approve, { action: 'approve', postId: changed.postId, versionHash: changed.versionHash });
    expect(await db.postStatus(first.postId)).toBe('approved');
    setNow('2026-11-10T08:01:00.000Z');
    expect((await job.tick(new Date('2026-11-10T08:01:00.000Z'), { businessId })).ran).toBe(0);
    expect(run.networkPosts()).toEqual([]);
    expect(templates(run)).toEqual([]);
  });
});

e2eTest('one channel failing every attempt: Instagram goes live, Facebook is retried, then the owner and team are told', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async ({ run, db, world, publishing, job, businessId, setNow }) => {
    const draft = await world.createDraft(businessId, CAPTION);
    await run.owner.tapsButton(draft.buttons.approve, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });
    await run.owner.sendsText('כן');

    // The publications run in network order: Instagram first, then Facebook fails three times.
    const publish = publishing.publish.bind(publishing);
    publishing.publish = async (request) => {
      if (request.network === 'facebook') throw new Error('facebook rate limited');
      return publish(request);
    };
    setNow('2026-11-04T08:01:00.000Z');
    await job.tick(new Date('2026-11-04T08:01:00.000Z'), { businessId });
    expect(run.networkPosts().filter((p) => p.outcome.ok).map((p) => p.network)).toEqual(['instagram']);
    expect(await db.postStatus(draft.postId)).toBe('publishing');
    expect(templates(run)).toEqual([]);

    // The retries run 5 and then 15 minutes later (the spacing is measured from the last attempt).
    const facebook = (await publications(db, draft.postId)).find((p) => p.network === 'facebook')!;
    for (let attempt = 2; attempt <= 3; attempt++) expect((await job.runPublication(facebook.id)).outcome).toBe(attempt < 3 ? 'retry_pending' : 'failed');

    expect(await db.postStatus(draft.postId)).toBe('partially_published');
    expect(templates(run).map((t) => t.template)).toEqual([
      { name: scheduleCopy.FAILED_TEMPLATE, language: 'he', variables: { topic: expect.any(String), failed: 'פייסבוק' } },
    ]);
    expect(await consoleItems(db, businessId)).toContainEqual(expect.objectContaining({ kind: 'publication_failed', status: 'open' }));
    expect(run.networkPosts().filter((p) => p.outcome.ok)).toHaveLength(1);
  });
});
