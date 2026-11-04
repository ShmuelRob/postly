/**
 * Cancellation, the data deletion schedule and the monthly report (WP-43; technical-design.md,
 * Cancellation, data deletion and the monthly report). Each case runs the real app on the simulators
 * (the H5 world in test/h5/subject.ts, with a placeholder renderer) and asserts on what the owner, the
 * networks and the team see. Template bodies are provisional.
 */
import Fastify from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { expect, inject } from 'vitest';
import type { ModelProvider, PaymentProvider, TemplateRenderer } from '../../src/contracts/providers/index.js';
import * as schema from '../../src/db/schema.js';
import { createConsole, registerConsoleRoutes } from '../../src/modules/console/index.js';
import type { Publishing } from '../../src/modules/publishing/index.js';
import { cancellationCopy } from '../../src/modules/workflow/index.js';
import { MessagingSimulator, PublishingSimulator, type PaymentSimulator } from '../../src/simulators/index.js';
import { openH5Db, type H5Db } from '../h5/db.js';
import { subjectApp, subjectExtras } from '../h5/subject.js';
import { createH5World, type H5World } from '../h5/world.js';
import type { App } from '../../src/app.js';
import { e2eTest, type E2eHarness, type E2eRun } from './harness/index.js';

const OWNER = '+972501233431';
const BUSINESS_PHONE = '+972501234560';
const CAPTION = 'צבעונים חדשים הגיעו, 25 ₪ לזר';
// Tuesday 2026-11-03 10:00 in Israel. The first proposed time is Wednesday 10:00 (08:00Z).
const START = '2026-11-03T08:00:00.000Z';
const PROPOSED = '2026-11-04T08:00:00.000Z';
const DAY = 24 * 60 * 60_000;

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
  files: Map<string, Uint8Array>;
  job: Publishing;
  businessId: string;
  setNow(iso: string): void;
}

/** An active business with Instagram and Facebook verified and a paid subscription, then `body`. */
async function withBusiness(e2e: E2eHarness, body: (ctx: Ctx) => Promise<void>) {
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
    const { payment: paymentSim, files } = subjectExtras(world!);
    // The owner pays: the payment link in WhatsApp, the provider's page, then its signed callback.
    await app.billing!.sendPaymentLink(businessId);
    const subscriptionId = paymentSim.completePayment(paymentSim.links.at(-1)!.link.providerCustomerId);
    expect(await app.billing!.handleWebhook(paymentSim.webhook(subscriptionId))).toMatchObject({ kind: 'applied', to: 'active' });
    const job = world!.publishingJob as Publishing;
    await body({ run, world: world!, app, db, publishing, payment: paymentSim, files, job, businessId, setNow: (iso) => (now = new Date(iso)) });
  } finally {
    await world?.close();
    await db.close();
  }
}

const read = <T>(db: H5Db, fn: Parameters<typeof db.db.withSystem<T>>[1]) => db.db.withSystem('console', fn);
const publications = (db: H5Db, postId: string) => read(db, (tx) => tx.select().from(schema.publication).where(eq(schema.publication.postId, postId)));
const consoleItems = (db: H5Db, businessId: string) => read(db, (tx) => tx.select().from(schema.consoleItem).where(eq(schema.consoleItem.businessId, businessId)));
const channels = (db: H5Db, businessId: string) => read(db, (tx) => tx.select().from(schema.channelConnection).where(eq(schema.channelConnection.businessId, businessId)));
const business = async (db: H5Db, businessId: string) => (await read(db, (tx) => tx.select().from(schema.business).where(eq(schema.business.id, businessId))))[0];
const subscription = async (db: H5Db, businessId: string) => (await read(db, (tx) => tx.select().from(schema.subscription).where(eq(schema.subscription.businessId, businessId))))[0];
const templates = (run: E2eRun) => run.owner.received().filter((m) => m.kind === 'template');

/** An approved draft with its times confirmed: one scheduled publication per network at PROPOSED. */
async function scheduledPost(ctx: Ctx) {
  const draft = await ctx.world.createDraft(ctx.businessId, CAPTION);
  await ctx.run.owner.tapsButton(draft.buttons.approve, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });
  await ctx.run.owner.sendsText('כן');
  const pubs = await publications(ctx.db, draft.postId);
  expect(pubs.map((p) => p.status)).toEqual(['scheduled', 'scheduled']);
  return draft;
}

e2eTest('the team cancels a business from the console: channels are disconnected at once, and nothing scheduled goes live', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async (ctx) => {
    const { run, app, db, publishing, payment: paymentSim, businessId, job, setNow } = ctx;
    const draft = await scheduledPost(ctx);
    const accounts = (await channels(db, businessId)).map((c) => c.providerAccountId);

    // The team's console action (loopback only).
    const server = Fastify({ logger: false });
    registerConsoleRoutes(server, { console: createConsole(ctx.db.db, app.workflow), cancelBusiness: (id) => app.cancellation.cancel(id, 'console') });
    const response = await server.inject({ method: 'POST', url: `/console/api/businesses/${businessId}/cancel` });
    await server.close();
    expect(response.statusCode).toBe(200);

    // Immediately, before any job runs: every channel revoked in Postly and disconnected at the provider.
    expect((await channels(db, businessId)).map((c) => c.status)).toEqual(['revoked', 'revoked']);
    expect(publishing.disconnections.map((d) => d.providerAccountId).sort()).toEqual([...accounts].sort());
    for (const network of ['instagram', 'facebook'] as const) {
      expect((await publishing.getConnectionStatus({ businessId, network })).status).toBe('disconnected');
    }
    expect((await publications(db, draft.postId)).map((p) => p.status)).toEqual(['cancelled', 'cancelled']);
    expect(await db.postStatus(draft.postId)).toBe('cancelled');
    const row = await business(db, businessId);
    expect(row).toMatchObject({ status: 'cancelled', cancelledAt: new Date(START), dataDeleteAfter: new Date(Date.parse(START) + 30 * DAY) });
    expect(await subscription(db, businessId)).toMatchObject({ status: 'cancelled' });
    expect((await paymentSim.getSubscriptionStatus((await subscription(db, businessId))!.providerSubscriptionId!)).status).toBe('cancelled');
    expect(templates(run).map((t) => t.template)).toEqual([
      { name: cancellationCopy.CANCELLED_TEMPLATE, language: 'he', variables: { deleteAfter: '03.12.2026' } },
    ]);

    // The proposed time passes: nothing reaches the networks.
    setNow('2026-11-04T08:01:00.000Z');
    await job.tick(new Date('2026-11-04T08:01:00.000Z'), { businessId });
    expect(run.networkPosts()).toEqual([]);
    expect(publishing.posts).toEqual([]);

    // Cancelling again changes nothing and tells the owner nothing more.
    expect(await app.cancellation.cancel(businessId, 'console')).toMatchObject({ outcome: 'cancelled', revoked: [] });
    expect(templates(run)).toHaveLength(1);
  });
});

e2eTest('the payment provider reports the subscription cancelled: the business is cancelled, and a failed provider disconnect still revokes and tells the team', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async ({ run, app, db, publishing, payment: paymentSim, businessId }) => {
    const providerSubscriptionId = (await subscription(db, businessId))!.providerSubscriptionId!;
    paymentSim.setStatus(providerSubscriptionId, 'cancelled');
    publishing.failNextDisconnect('provider outage');

    expect(await app.billing!.handleWebhook(paymentSim.webhook(providerSubscriptionId))).toMatchObject({ kind: 'applied', to: 'cancelled' });

    expect((await business(db, businessId))?.status).toBe('cancelled');
    expect((await channels(db, businessId)).map((c) => c.status)).toEqual(['revoked', 'revoked']);
    // One disconnect failed at the provider: the team finishes it there.
    expect(publishing.disconnections).toHaveLength(1);
    const items = (await consoleItems(db, businessId)).filter((i) => i.kind === 'channel_disconnected');
    run.recordConsoleItems(items.map((i) => ({ kind: i.kind, details: i.details })));
    expect(items.map((i) => i.details)).toEqual([expect.objectContaining({ reason: 'cancellation', error: 'provider outage' })]);
    // The owner gets the cancellation template only, not billing's text as well.
    const last = run.owner.received().at(-1);
    expect(last?.template?.name).toBe(cancellationCopy.CANCELLED_TEMPLATE);
    expect(run.owner.received().filter((m) => m.text === 'המנוי בוטל.')).toEqual([]);
  });
});

e2eTest('the data deletion schedule: kept for 30 days after cancellation, then every row and file of the business is deleted', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async (ctx) => {
    const { app, db, files, businessId, setNow } = ctx;
    const draft = await scheduledPost(ctx);
    expect([...files.keys()].some((p) => p.startsWith(`${businessId}/`))).toBe(true);
    await app.cancellation.cancel(businessId, 'console');

    /** Rows of the business in every business-owned table (the console role sees them all). */
    const counts = () =>
      read(db, async (tx) => {
        const out: Record<string, number> = {};
        for (const table of ['business', 'channel_connection', 'conversation_state', 'message', 'media_asset', 'weekly_update', 'post', 'post_version', 'approval', 'publication', 'subscription', 'console_item']) {
          const column = table === 'business' ? 'id' : 'business_id';
          const [row] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(column)} = ${businessId}`);
          out[table] = Number(row!.n);
        }
        return out;
      });
    const before = await counts();
    for (const table of ['business', 'channel_connection', 'message', 'post', 'post_version', 'approval', 'publication', 'subscription']) expect(before[table], table).toBeGreaterThan(0);

    // Day 29: nothing is deleted.
    const day29 = new Date(Date.parse(START) + 29 * DAY);
    setNow(day29.toISOString());
    expect(await app.dataDeletion.tick(day29, { businessId })).toEqual([]);
    expect(await counts()).toEqual(before);

    // Day 30, the next daily run: the business and everything it owns are gone, files included.
    const day30 = new Date(Date.parse(START) + 30 * DAY + 60 * 60_000);
    setNow(day30.toISOString());
    expect(await app.dataDeletion.tick(day30, { businessId })).toEqual([businessId]);
    expect(Object.values(await counts()).every((n) => n === 0)).toBe(true);
    expect([...files.keys()].filter((p) => p.startsWith(`${businessId}/`))).toEqual([]);
    expect(await db.postStatus(draft.postId).catch(() => 'gone')).not.toBe('cancelled');

    // A later run finds nothing.
    expect(await app.dataDeletion.tick(new Date(day30.getTime() + DAY), { businessId })).toEqual([]);
  });
});

e2eTest('the monthly report: the owner gets the previous month’s posts, reach and engagement, and nothing for a month without data', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async (ctx) => {
    const { run, app, publishing, businessId, job, setNow } = ctx;
    await scheduledPost(ctx);
    setNow('2026-11-04T08:01:00.000Z');
    await job.tick(new Date('2026-11-04T08:01:00.000Z'), { businessId });
    expect(run.networkPosts().map((p) => p.network).sort()).toEqual(['facebook', 'instagram']);
    const [ig] = publishing.postsOn('instagram');
    const [fb] = publishing.postsOn('facebook');
    publishing.setMetrics(ig!.providerPostId, { reach: 1200, likes: 85, comments: 7 });
    publishing.setMetrics(fb!.providerPostId, { reach: 340, shares: 4 });
    const before = templates(run).length;

    // A run in mid-month reports October, when nothing was published: nothing is sent.
    expect(await app.monthlyReport.tick(new Date('2026-11-15T06:00:00.000Z'), { businessId })).toEqual({ sent: [] });

    // December 1st reports November.
    setNow('2026-12-01T06:00:00.000Z');
    expect(await app.monthlyReport.tick(new Date('2026-12-01T06:00:00.000Z'), { businessId })).toEqual({ sent: [businessId] });
    expect(templates(run).slice(before).map((t) => t.template)).toEqual([
      { name: cancellationCopy.MONTHLY_REPORT_TEMPLATE, language: 'he', variables: { month: 'נובמבר 2026', posts: '1', reach: '1,540', engagement: '96' } },
    ]);

    // January 1st reports December: nothing was published, nothing is sent.
    setNow('2027-01-01T06:00:00.000Z');
    expect(await app.monthlyReport.tick(new Date('2027-01-01T06:00:00.000Z'), { businessId })).toEqual({ sent: [] });
    expect(templates(run).length).toBe(before + 1);
  });
});

e2eTest('the monthly report sends nothing when the provider supplies no metric', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async (ctx) => {
    const { run, app, businessId, job, setNow } = ctx;
    await scheduledPost(ctx);
    setNow('2026-11-04T08:01:00.000Z');
    await job.tick(new Date('2026-11-04T08:01:00.000Z'), { businessId });
    expect(run.networkPosts()).toHaveLength(2);
    const before = templates(run).length;

    setNow('2026-12-01T06:00:00.000Z');
    expect(await app.monthlyReport.tick(new Date('2026-12-01T06:00:00.000Z'), { businessId })).toEqual({ sent: [] });
    expect(templates(run).length).toBe(before);
  });
});
