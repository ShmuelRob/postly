/**
 * Cancellation, archiving, erasure on request and the monthly report (WP-43, archiving 2026-11-07;
 * technical-design.md, Cancellation, archiving, erasure and the monthly report). Each case runs the real app on the simulators
 * (the H5 world in test/h5/subject.ts, with a placeholder renderer) and asserts on what the owner, the
 * networks and the team see. Template bodies are provisional.
 */
import Fastify from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { expect, inject } from 'vitest';
import type { ModelProvider, PaymentProvider, TemplateRenderer } from '../../src/contracts/providers/index.js';
import * as schema from '../../src/db/schema.js';
import { createErasure } from '../../src/modules/business-data/index.js';
import { createConsole, DEV_ACTOR, registerConsoleRoutes } from '../../src/modules/console/index.js';
import type { Publishing } from '../../src/modules/publishing/index.js';
import { cancellationCopy } from '../../src/modules/workflow/index.js';
import { MessagingSimulator, PublishingSimulator, type PaymentSimulator } from '../../src/simulators/index.js';
import { openH5Db, type H5Db } from '../h5/db.js';
import { subjectApp, subjectExtras } from '../h5/subject.js';
import { createH5World, type H5World } from '../h5/world.js';
import type { App } from '../../src/app.js';
import { e2eTest, type E2eHarness, type E2eRun } from './harness/index.js';

const OWNER = '+972501233431';
const OTHER_OWNER = '+972501233432';
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
    // D2 (WP-83): without the business name typed as confirmation, nothing happens.
    const url = `/console/api/businesses/${businessId}/cancel`;
    const refused = await server.inject({ method: 'POST', url, payload: { confirmName: 'not the name' } });
    expect(refused.statusCode).toBe(400);
    expect((await channels(db, businessId)).map((c) => c.status)).toEqual(['verified', 'verified']);
    expect((await business(db, businessId))?.status).toBe('active');
    const name = (await business(db, businessId))!.name;
    const response = await server.inject({ method: 'POST', url, payload: { confirmName: name } });
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
    expect(row).toMatchObject({ status: 'cancelled', cancelledAt: new Date(START), archiveAfter: new Date(Date.parse(START) + 30 * DAY) });
    expect(await subscription(db, businessId)).toMatchObject({ status: 'cancelled' });
    expect((await paymentSim.getSubscriptionStatus((await subscription(db, businessId))!.providerSubscriptionId!)).status).toBe('cancelled');
    expect(templates(run).map((t) => t.template)).toEqual([
      { name: cancellationCopy.CANCELLED_TEMPLATE, language: 'he', variables: {} },
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

/** Rows of the business in every business-owned table (the console role sees them all). */
const BUSINESS_TABLES = ['business', 'channel_connection', 'conversation_state', 'message', 'media_asset', 'weekly_update', 'post', 'post_version', 'approval', 'publication', 'subscription', 'console_item'];
const counts = (db: H5Db, businessId: string) =>
  read(db, async (tx) => {
    const out: Record<string, number> = {};
    for (const table of BUSINESS_TABLES) {
      const column = table === 'business' ? 'id' : 'business_id';
      const [row] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(column)} = ${businessId}`);
      out[table] = Number(row!.n);
    }
    return out;
  });
const auditRows = (db: H5Db, businessId: string) => read(db, (tx) => tx.select().from(schema.workflowEvent).where(eq(schema.workflowEvent.businessId, businessId)));
const businessFiles = (files: Map<string, Uint8Array>, businessId: string) => [...files.keys()].filter((p) => p.startsWith(`${businessId}/`));

/** The console server with the cancel and erase actions wired, as main.ts wires them; `erasure` replaces the app's (a failing store). */
function consoleServer(ctx: Ctx, erasure = ctx.app.erasure) {
  const server = Fastify({ logger: false });
  registerConsoleRoutes(server, {
    console: createConsole(ctx.db.db, ctx.app.workflow),
    cancelBusiness: (id) => ctx.app.cancellation.cancel(id, 'console'),
    eraseBusiness: (id, request) => erasure.erase(id, request),
  });
  return server;
}

/** The names in the console's Conversations list, for one filter. */
async function listed(server: ReturnType<typeof Fastify>, kind?: string) {
  const html = (await server.inject({ method: 'GET', url: `/console?tab=conversations${kind ? `&kind=${kind}` : ''}` })).body;
  const list = html.slice(html.indexOf('data-testid="conversation-list"'));
  return list.slice(0, list.indexOf('</ul>'));
}

e2eTest('cancellation keeps the data: still readable through the retention period, then archived with every row and file kept', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async (ctx) => {
    const { run, app, db, files, businessId, setNow, world } = ctx;
    const draft = await scheduledPost(ctx);
    expect(businessFiles(files, businessId).length).toBeGreaterThan(0);
    await app.cancellation.cancel(businessId, 'console');
    // The owner is told the data is kept, with no deletion date.
    expect(templates(run).map((t) => t.template)).toEqual([{ name: cancellationCopy.CANCELLED_TEMPLATE, language: 'he', variables: {} }]);
    expect(cancellationCopy.CANCELLED_TEMPLATE_BODY).not.toMatch(/יימחקו|{{/);
    // A second business, cancelled ten days later, is not due when the first one is.
    const otherId = await world.createBusiness(OTHER_OWNER);
    setNow(new Date(Date.parse(START) + 10 * DAY).toISOString());
    await app.cancellation.cancel(otherId, 'console');
    const both = [businessId, otherId];
    const before = await counts(db, businessId);
    for (const table of ['business', 'channel_connection', 'message', 'post', 'post_version', 'approval', 'publication', 'subscription']) expect(before[table], table).toBeGreaterThan(0);
    const filesBefore = businessFiles(files, businessId);

    // Day 29: still cancelled, every row readable.
    const day29 = new Date(Date.parse(START) + 29 * DAY);
    setNow(day29.toISOString());
    expect(await app.archive.tick(day29, { businessIds: both })).toEqual([]);
    expect(await business(db, businessId)).toMatchObject({ status: 'cancelled', archiveAfter: new Date(Date.parse(START) + 30 * DAY), archivedAt: null });
    expect(await counts(db, businessId)).toEqual(before);

    // Day 30, the next daily run: archived, and nothing is deleted, rows or files.
    const day30 = new Date(Date.parse(START) + 30 * DAY + 60 * 60_000);
    setNow(day30.toISOString());
    const sentBefore = run.owner.received().length;
    expect(await app.archive.tick(day30, { businessIds: both })).toEqual([businessId]);
    expect(await business(db, businessId)).toMatchObject({ status: 'archived', archivedAt: day30 });
    expect(await counts(db, businessId)).toEqual(before);
    expect(businessFiles(files, businessId)).toEqual(filesBefore);
    expect(await db.postStatus(draft.postId)).toBe('cancelled');
    expect((await auditRows(db, businessId)).filter((e) => e.event === 'ARCHIVE').map((e) => [e.fromState, e.toState, e.source])).toEqual([['cancelled', 'archived', 'system']]);
    // The business not due yet keeps its state and its date.
    expect(await business(db, otherId)).toMatchObject({ status: 'cancelled', archiveAfter: new Date(Date.parse(START) + 40 * DAY) });

    // Archived: no processing and no messages. The owner's text is stored for the team, and nothing is answered.
    await run.owner.sendsText('שלום, אפשר לחזור?');
    expect(run.owner.received()).toHaveLength(sentBefore);
    expect((await counts(db, businessId)).message).toBe(before.message! + 1);

    // The console: hidden from the normal list, shown under Archived, and its client panel still opens.
    const server = consoleServer(ctx);
    const name = (await business(db, businessId))!.name;
    // Every test business has the same name, so the list is checked by the business id in its links.
    expect(await listed(server)).not.toContain(`business=${businessId}`);
    expect(await listed(server, 'archived')).toContain(`business=${businessId}`);
    const panel = await server.inject({ method: 'GET', url: `/console?tab=conversations&business=${businessId}&panel=client` });
    expect(panel.statusCode).toBe(200);
    expect(panel.body).toContain(name);

    // A later run finds nothing; the other business's own day comes ten days later.
    expect(await app.archive.tick(new Date(day30.getTime() + DAY), { businessIds: both })).toEqual([]);
    expect(await app.archive.tick(new Date(Date.parse(START) + 40 * DAY + 60 * 60_000), { businessIds: both })).toEqual([otherId]);

    // Months later the owner asks to be erased: an archived business is erased like a cancelled one.
    const erased = await server.inject({
      method: 'POST',
      url: `/console/api/businesses/${businessId}/erase`,
      payload: { confirmName: name, requestedBy: 'owner', channel: 'email', requestedAt: '2027-02-01T09:00:00.000Z' },
    });
    await server.close();
    expect(erased.statusCode).toBe(200);
    expect(erased.json()).toEqual({ outcome: 'erased' });
    expect(Object.values(await counts(db, businessId)).every((n) => n === 0)).toBe(true);
    expect(businessFiles(files, businessId)).toEqual([]);
    expect((await auditRows(db, businessId)).some((e) => e.event === 'ARCHIVE')).toBe(true);
  });
});

e2eTest('erasure on request: the team erases a cancelled business from the console; every row and file goes, the workflow audit trail stays', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async (ctx) => {
    const { app, db, files, businessId } = ctx;
    await scheduledPost(ctx);
    const server = consoleServer(ctx);
    const url = `/console/api/businesses/${businessId}/erase`;
    const name = (await business(db, businessId))!.name;
    const request = { confirmName: name, requestedBy: 'owner', channel: 'whatsapp', requestedAt: '2026-11-03T09:30:00.000Z' };

    // An active business cannot be erased: it is cancelled first, so channels and the subscription are closed.
    const active = await server.inject({ method: 'POST', url, payload: request });
    expect(active.statusCode).toBe(409);
    expect(active.json()).toMatchObject({ reason: 'not_cancelled' });
    expect((await business(db, businessId))?.status).toBe('active');

    await app.cancellation.cancel(businessId, 'console');
    const before = await counts(db, businessId);
    const audit = await auditRows(db, businessId);
    expect(audit.length).toBeGreaterThan(0);

    // Without the business name, or without who asked and how, nothing happens.
    expect((await server.inject({ method: 'POST', url, payload: { ...request, confirmName: 'not the name' } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url, payload: { confirmName: name } })).statusCode).toBe(400);
    expect(await counts(db, businessId)).toEqual(before);

    const erased = await server.inject({ method: 'POST', url, payload: request });
    expect(erased.statusCode).toBe(200);
    expect(erased.json()).toEqual({ outcome: 'erased' });

    // Every row and file of the business is gone.
    expect(Object.values(await counts(db, businessId)).every((n) => n === 0)).toBe(true);
    expect(businessFiles(files, businessId)).toEqual([]);
    // The workflow audit trail stays, and the erasure itself is recorded: who asked, how, when, and who ran it.
    expect(await auditRows(db, businessId)).toEqual(audit);
    const records = await read(db, (tx) => tx.select().from(schema.erasureRequest).where(eq(schema.erasureRequest.businessId, businessId)));
    expect(records).toEqual([
      expect.objectContaining({ requestedBy: 'owner', channel: 'whatsapp', requestedAt: new Date(request.requestedAt), actor: DEV_ACTOR }),
    ]);

    // Running it again finds nothing.
    expect((await server.inject({ method: 'POST', url, payload: request })).statusCode).toBe(404);
    await server.close();
  });
});


e2eTest('erasure whose files cannot be deleted: the rows are erased and recorded, and the console answers 500 files_failed', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async (ctx) => {
    const { app, db, files, businessId } = ctx;
    await scheduledPost(ctx);
    await app.cancellation.cancel(businessId, 'console');
    const stored = businessFiles(files, businessId);
    expect(stored.length).toBeGreaterThan(0);
    // The storage refuses every delete (a Cloud Storage outage).
    const outage = () => Promise.reject(new Error('storage unavailable'));
    const server = consoleServer(ctx, createErasure({ db: db.db, storage: { removePrefix: outage, remove: outage } }));
    const name = (await business(db, businessId))!.name;
    const response = await server.inject({
      method: 'POST',
      url: `/console/api/businesses/${businessId}/erase`,
      payload: { confirmName: name, requestedBy: 'representative', channel: 'letter', requestedAt: '2026-11-03T09:30:00.000Z' },
    });
    await server.close();
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ reason: 'files_failed' });
    // The rows are gone and the request recorded; the files are left for the team.
    expect(Object.values(await counts(db, businessId)).every((n) => n === 0)).toBe(true);
    const records = await read(db, (tx) => tx.select().from(schema.erasureRequest).where(eq(schema.erasureRequest.businessId, businessId)));
    expect(records).toEqual([expect.objectContaining({ requestedBy: 'representative', channel: 'letter', actor: DEV_ACTOR })]);
    expect(businessFiles(files, businessId)).toEqual(stored);
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

e2eTest('a cancellation that stopped half way finishes when run again, and the owner is told exactly once (review of PR #54)', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async ({ run, app, db, payment: paymentSim, businessId }) => {
    const cancel = paymentSim.cancelSubscription.bind(paymentSim);
    let calls = 0;
    let lockFree: boolean | undefined;
    paymentSim.cancelSubscription = async (id) => {
      calls += 1;
      if (calls === 1) throw new Error('payment provider down');
      // The provider is called with no subscription row lock held: another transaction takes it at once.
      lockFree = await db.db
        .withBusiness('billing', businessId, (tx) => tx.execute(sql`select id from subscription for update nowait`))
        .then(() => true, () => false);
      return cancel(id);
    };

    await expect(app.cancellation.cancel(businessId, 'console')).rejects.toThrow('payment provider down');
    // The steps before the failure held: cancelled and disconnected; the owner is not told yet.
    expect((await business(db, businessId))?.status).toBe('cancelled');
    expect((await channels(db, businessId)).map((c) => c.status)).toEqual(['revoked', 'revoked']);
    expect(templates(run)).toEqual([]);
    expect((await subscription(db, businessId))?.status).toBe('active');

    // The team runs it again: the subscription is cancelled and the owner gets the template once.
    expect(await app.cancellation.cancel(businessId, 'console')).toMatchObject({ outcome: 'cancelled' });
    expect(lockFree).toBe(true);
    expect((await subscription(db, businessId))?.status).toBe('cancelled');
    expect(templates(run).map((t) => t.template?.name)).toEqual([cancellationCopy.CANCELLED_TEMPLATE]);
    await app.cancellation.cancel(businessId, 'console');
    expect(templates(run)).toHaveLength(1);
  });
});
