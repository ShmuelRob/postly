/**
 * The billing hold (T16; technical-design.md, Billing): an owner who does not pay gets reminders on
 * days 1, 3 and 6 of the grace period, and on day 7 the business is paused through the existing
 * business pause, so its approved, scheduled post waits while the drafts and data stay. A payment
 * resumes the business and the post goes live. Runs the real app on the simulators (the H5 world in
 * test/h5/subject.ts). Template bodies are provisional (H6).
 */
import { eq } from 'drizzle-orm';
import { expect, inject } from 'vitest';
import type { App } from '../../src/app.js';
import type { ModelProvider, PaymentProvider, TemplateRenderer } from '../../src/contracts/providers/index.js';
import * as schema from '../../src/db/schema.js';
import { holdCopy } from '../../src/modules/billing/index.js';
import type { Publishing } from '../../src/modules/publishing/index.js';
import { MessagingSimulator, PublishingSimulator, type PaymentSimulator } from '../../src/simulators/index.js';
import { openH5Db, type H5Db } from '../h5/db.js';
import { subjectApp, subjectExtras } from '../h5/subject.js';
import { createH5World, type H5World } from '../h5/world.js';
import { e2eTest, type E2eHarness, type E2eRun } from './harness/index.js';

const OWNER = '+972501233451';
const BUSINESS_PHONE = '+972501234561';
const CAPTION = 'צבעונים חדשים הגיעו, 25 ₪ לזר';
// Tuesday 2026-11-03 10:00 in Israel; the first proposed time is Wednesday 10:00 (08:00Z).
const START = '2026-11-03T08:00:00.000Z';
const DAY = 24 * 60 * 60_000;
const at = (days: number) => new Date(Date.parse(START) + days * DAY + 60_000);

const notUsed = (what: string) => () => Promise.reject(new Error(`${what} is not used in this test`));
const model: ModelProvider = { name: 'unused', generateStructured: notUsed('model'), analyzeImage: notUsed('model'), transcribeAudio: notUsed('model') };
const payment: PaymentProvider = { name: 'unused', createPaymentLink: notUsed('payment'), getSubscriptionStatus: notUsed('payment'), cancelSubscription: notUsed('payment') };
const renderer: TemplateRenderer = { render: notUsed('renderer') };

interface Ctx {
  run: E2eRun;
  world: H5World;
  app: App;
  db: H5Db;
  publishing: PublishingSimulator;
  payment: PaymentSimulator;
  job: Publishing;
  businessId: string;
  /** Moves the clock and runs the daily billing-hold tick, as the worker does. */
  day(days: number): Promise<void>;
}

/** An active business with Instagram and Facebook verified that has not paid yet, then `body`. */
async function withUnpaidBusiness(e2e: E2eHarness, body: (ctx: Ctx) => Promise<void>) {
  let now = new Date(START);
  const clock = () => now;
  const publishing = new PublishingSimulator({ now: clock });
  const messaging = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const db = openH5Db();
  let world: H5World | undefined;
  const run = await e2e.start({
    providers: { messaging, publishing, model, payment, renderer },
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
    const app = subjectApp(world!);
    const { payment: paymentSim } = subjectExtras(world!);
    const day = async (days: number) => {
      now = at(days);
      await app.billingHold!.tick(now, { businessId });
    };
    await body({ run, world: world!, app, db, publishing, payment: paymentSim, job: world!.publishingJob as Publishing, businessId, day });
  } finally {
    await world?.close();
    await db.close();
  }
}

const read = <T>(db: H5Db, fn: Parameters<typeof db.db.withSystem<T>>[1]) => db.db.withSystem('console', fn);
const publications = (db: H5Db, postId: string) => read(db, (tx) => tx.select().from(schema.publication).where(eq(schema.publication.postId, postId)));
const business = async (db: H5Db, businessId: string) => (await read(db, (tx) => tx.select().from(schema.business).where(eq(schema.business.id, businessId))))[0];
const subscription = async (db: H5Db, businessId: string) => (await read(db, (tx) => tx.select().from(schema.subscription).where(eq(schema.subscription.businessId, businessId))))[0];
const versions = (db: H5Db, postId: string) => read(db, (tx) => tx.select().from(schema.postVersion).where(eq(schema.postVersion.postId, postId)));
const templates = (run: E2eRun) => run.owner.received().filter((m) => m.kind === 'template').map((m) => m.template!);

/** An approved draft with its times confirmed: one scheduled publication per network on Wednesday. */
async function scheduledPost(ctx: Ctx) {
  const draft = await ctx.world.createDraft(ctx.businessId, CAPTION);
  await ctx.run.owner.tapsButton(draft.buttons.approve, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });
  await ctx.run.owner.sendsText('כן');
  expect((await publications(ctx.db, draft.postId)).map((p) => p.status)).toEqual(['scheduled', 'scheduled']);
  return draft;
}

e2eTest('an owner who never pays gets reminders on days 1, 3 and 6, publishing pauses on day 7 with everything kept, and paying resumes it', { timeout: 90_000 }, async ({ e2e }) => {
  await withUnpaidBusiness(e2e, async (ctx) => {
    const { run, app, db, publishing, payment: paymentSim, businessId, job, day } = ctx;
    // Onboarding sends the first payment link: the grace period starts now.
    await app.billing!.sendPaymentLink(businessId);
    expect(await subscription(db, businessId)).toMatchObject({ status: 'pending', graceStartedAt: new Date(START), remindersSent: 0, heldAt: null });
    const draft = await scheduledPost(ctx);
    // The post's time is a week away: it would go live after the hold starts.
    await read(db, (tx) => tx.update(schema.publication).set({ scheduledFor: at(8) }).where(eq(schema.publication.postId, draft.postId)));

    // Day 0 and day 2: nothing is due.
    await day(0);
    await day(2);
    expect(templates(run)).toEqual([]);

    for (const d of [1, 3, 6]) {
      await day(d);
      await day(d); // the tick runs again the same day: no second reminder
    }
    const reminders = templates(run);
    expect(reminders.map((t) => t.name)).toEqual([holdCopy.REMINDER_TEMPLATE, holdCopy.REMINDER_TEMPLATE, holdCopy.REMINDER_TEMPLATE]);
    expect(reminders[0]!.variables).toMatchObject({ businessName: expect.any(String), holdOn: '10.11.2026' });
    // Each reminder carries a fresh payment link at the current price.
    expect(paymentSim.links).toHaveLength(4);
    expect(paymentSim.links.every((l) => l.request.price.amountAgorot === 30000)).toBe(true);
    expect(await business(db, businessId)).toMatchObject({ status: 'active' });

    // Day 7: the hold. The business is paused; the owner is told; nothing is deleted or cancelled.
    await day(7);
    await day(7);
    expect(await business(db, businessId)).toMatchObject({ status: 'paused' });
    expect(await subscription(db, businessId)).toMatchObject({ status: 'pending', remindersSent: 3, heldAt: at(7) });
    expect(templates(run).slice(3)).toEqual([{ name: holdCopy.HOLD_TEMPLATE, language: 'he', variables: { businessName: expect.any(String) } }]);

    // The post's time comes during the hold: the publishing job defers it, and the post, its approved
    // version and its publications stay as they were.
    await day(8);
    await job.tick(at(8), { businessId });
    expect(run.networkPosts()).toEqual([]);
    expect(publishing.posts).toEqual([]);
    expect((await publications(db, draft.postId)).map((p) => p.status)).toEqual(['scheduled', 'scheduled']);
    expect(await db.postStatus(draft.postId)).toBe('scheduled');
    expect((await versions(db, draft.postId)).map((v) => v.contentHash)).toContain(draft.versionHash);

    // The owner pays through the latest reminder's link; the provider calls back.
    const subscriptionId = paymentSim.completePayment(paymentSim.links.at(-1)!.link.providerCustomerId);
    expect(await app.billing!.handleWebhook(paymentSim.webhook(subscriptionId))).toMatchObject({ kind: 'applied', to: 'active' });
    expect(await business(db, businessId)).toMatchObject({ status: 'active' });
    expect(await subscription(db, businessId)).toMatchObject({ status: 'active', graceStartedAt: null, remindersSent: 0, heldAt: null });

    // The next publishing tick publishes the waiting post on both networks.
    await job.tick(at(8), { businessId });
    expect(publishing.posts.map((p) => p.request.network).sort()).toEqual(['facebook', 'instagram']);
    expect((await publications(db, draft.postId)).map((p) => p.status)).toEqual(['published', 'published']);

    // Paid: later ticks send nothing more.
    await day(12);
    expect(templates(run).filter((t) => t.name !== 'publication_confirmation')).toHaveLength(4);
  });
});

e2eTest('a failed renewal starts its own grace period, the hold pauses publishing, and the recovery resumes it', { timeout: 90_000 }, async ({ e2e }) => {
  await withUnpaidBusiness(e2e, async (ctx) => {
    const { run, app, db, payment: paymentSim, businessId, day } = ctx;
    await app.billing!.sendPaymentLink(businessId);
    const subscriptionId = paymentSim.completePayment(paymentSim.links.at(-1)!.link.providerCustomerId);
    await app.billing!.handleWebhook(paymentSim.webhook(subscriptionId));
    expect(await subscription(db, businessId)).toMatchObject({ status: 'active', graceStartedAt: null });

    // Days later the renewal fails: the grace period starts at the failure, not at the first link.
    await day(20);
    paymentSim.setStatus(subscriptionId, 'past_due');
    await app.billing!.handleWebhook(paymentSim.webhook(subscriptionId));
    expect(await subscription(db, businessId)).toMatchObject({ status: 'past_due', graceStartedAt: at(20), remindersSent: 0 });

    for (const d of [21, 23, 26]) await day(d);
    const sent = templates(run);
    expect(sent.map((t) => t.name)).toEqual([holdCopy.FAILED_TEMPLATE, holdCopy.FAILED_TEMPLATE, holdCopy.FAILED_TEMPLATE]);
    expect(sent[0]!.variables).toMatchObject({ holdOn: '30.11.2026' });
    // No new link for a past_due subscription: it would detach the provider's subscription.
    expect(paymentSim.links).toHaveLength(1);

    await day(27);
    expect(await business(db, businessId)).toMatchObject({ status: 'paused' });
    expect(templates(run).at(-1)?.name).toBe(holdCopy.HOLD_TEMPLATE);

    paymentSim.setStatus(subscriptionId, 'active');
    expect(await app.billing!.handleWebhook(paymentSim.webhook(subscriptionId))).toMatchObject({ kind: 'applied', from: 'past_due', to: 'active' });
    expect(await business(db, businessId)).toMatchObject({ status: 'active' });
    expect(await subscription(db, businessId)).toMatchObject({ heldAt: null, graceStartedAt: null });
  });
});

e2eTest('a payment never lifts a pause the team set, and the hold never stacks on it', { timeout: 90_000 }, async ({ e2e }) => {
  await withUnpaidBusiness(e2e, async (ctx) => {
    const { run, app, db, payment: paymentSim, businessId, day } = ctx;
    await app.billing!.sendPaymentLink(businessId);
    expect(await app.workflow.apply(businessId, { machine: 'business', id: businessId, event: 'PAUSE', source: 'console' })).toMatchObject({ ok: true });

    await day(1);
    await day(7);
    // A paused business is skipped: no reminder, no hold.
    expect(templates(run)).toEqual([]);
    expect(await subscription(db, businessId)).toMatchObject({ heldAt: null, remindersSent: 0 });

    const subscriptionId = paymentSim.completePayment(paymentSim.links.at(-1)!.link.providerCustomerId);
    await app.billing!.handleWebhook(paymentSim.webhook(subscriptionId));
    expect(await subscription(db, businessId)).toMatchObject({ status: 'active' });
    expect(await business(db, businessId)).toMatchObject({ status: 'paused' });
  });
});
