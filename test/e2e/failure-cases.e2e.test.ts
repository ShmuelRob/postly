/**
 * Failure cases (WP-35; technical-design.md, Failure handling required in Phase 1). Each case runs
 * the real app on the simulators (the H5 world in test/h5/subject.ts, with a placeholder renderer)
 * and asserts on what the owner and the networks see. Cases already covered elsewhere:
 * one channel failing (publishing.e2e.test.ts), an unknown number's text and Approve tap
 * (messaging.e2e.test.ts, approval.e2e.test.ts), failed model validation (model-validation.e2e.test.ts,
 * drafts.e2e.test.ts). Copy and template bodies are provisional.
 */
import { eq } from 'drizzle-orm';
import { expect, inject } from 'vitest';
import type { ModelProvider, PaymentProvider, TemplateRenderer } from '../../src/contracts/providers/index.js';
import * as schema from '../../src/db/schema.js';
import type { Publishing } from '../../src/modules/publishing/index.js';
import { draftsCopy, scheduleCopy } from '../../src/modules/workflow/index.js';
import { MessagingSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { openH5Db, type H5Db } from '../h5/db.js';
import { subjectApp } from '../h5/subject.js';
import { createH5World, type H5World } from '../h5/world.js';
import type { App } from '../../src/app.js';
import { e2eTest, type E2eHarness, type E2eRun } from './harness/index.js';

const OWNER = '+972501233351';
const STRANGER = '+972509990035';
const BUSINESS_PHONE = '+972501234560';
const CAPTION = 'צבעונים חדשים הגיעו, 25 ₪ לזר';
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
  app: App;
  db: H5Db;
  messaging: MessagingSimulator;
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
    const job = world!.publishingJob as Publishing;
    await body({ run, world: world!, app: subjectApp(world!), db, messaging, publishing, job, businessId, setNow: (iso) => (now = new Date(iso)) });
  } finally {
    await world?.close();
    await db.close();
  }
}

const read = <T>(db: H5Db, fn: Parameters<typeof db.db.withSystem<T>>[1]) => db.db.withSystem('console', fn);
const publications = (db: H5Db, postId: string) => read(db, (tx) => tx.select().from(schema.publication).where(eq(schema.publication.postId, postId)));
const consoleItems = (db: H5Db, businessId: string) => read(db, (tx) => tx.select().from(schema.consoleItem).where(eq(schema.consoleItem.businessId, businessId)));
const channels = (db: H5Db, businessId: string) => read(db, (tx) => tx.select().from(schema.channelConnection).where(eq(schema.channelConnection.businessId, businessId)));
const templates = (run: E2eRun) => run.owner.received().filter((m) => m.kind === 'template');

e2eTest('the window closed before the drafts were ready: a template asks the owner to write, then the drafts follow', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async ({ run, world, db, businessId, setNow }) => {
    // The owner last wrote at START; the drafts are ready a day and an hour later.
    setNow('2026-11-04T09:00:00.000Z');
    const draft = await world.createDraft(businessId, CAPTION);

    expect(run.owner.received().filter((m) => m.kind !== 'template')).toEqual([]);
    expect(templates(run).map((t) => t.template)).toEqual([
      { name: draftsCopy.DRAFTS_READY_TEMPLATE, language: 'he', variables: { businessName: 'פרחי השכונה' } },
    ]);
    expect(await db.postStatus(draft.postId)).toBe('awaiting_approval');

    // Whatever the owner writes now, the drafts come with their buttons; the text approves nothing.
    await run.owner.sendsText('היי, מה קורה?');
    const after = run.owner.received().slice(1);
    expect(after[0]?.text).toBe(draftsCopy.draftsHere);
    expect(after.at(-1)?.kind).toBe('buttons');
    expect(await db.postStatus(draft.postId)).toBe('awaiting_approval');

    await run.owner.tapsButton(draft.buttons.approve, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });
    expect(await db.postStatus(draft.postId)).toBe('approved');
    expect(run.owner.received().at(-1)?.text).toContain('אלה הזמנים שאני מציע');
  });
});

e2eTest('a draft with no response stays unapproved and never goes live, however long it waits', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async ({ run, world, db, app, job, businessId, setNow }) => {
    const draft = await world.createDraft(businessId, CAPTION);
    const sent = run.owner.received().length;

    for (const day of ['2026-11-04', '2026-11-08', '2026-11-15', '2026-11-30']) {
      setNow(`${day}T08:00:00.000Z`);
      await job.tick(new Date(`${day}T08:00:00.000Z`), { businessId });
      await app.channelHealth.tick(new Date(`${day}T04:00:00.000Z`), { businessId });
    }

    expect(await db.postStatus(draft.postId)).toBe('awaiting_approval');
    expect(await publications(db, draft.postId)).toEqual([]);
    expect(run.networkPosts()).toEqual([]);
    expect(run.owner.received()).toHaveLength(sent);
  });
});

e2eTest('a confirmation after the proposed time passed gets new times, and the post publishes at the new time', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async ({ run, world, db, job, businessId, setNow }) => {
    const draft = await world.createDraft(businessId, CAPTION);
    await run.owner.tapsButton(draft.buttons.approve, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });
    expect(run.owner.received().at(-1)?.text).toContain('יום רביעי 4.11 בשעה 10:00');

    // The owner answers on Wednesday at 11:00, after the proposed 10:00.
    setNow('2026-11-04T09:00:00.000Z');
    await run.owner.sendsText('כן');
    const late = run.owner.received().at(-1)?.text ?? '';
    expect(late).toContain('הזמן שהצעתי כבר עבר');
    expect(late).toContain('יום חמישי 5.11 בשעה 10:00');
    expect(await db.postStatus(draft.postId)).toBe('approved');
    expect(await publications(db, draft.postId)).toEqual([]);

    await run.owner.sendsText('כן');
    expect(run.owner.received().at(-1)?.text).toContain('מתוזמן');
    for (const p of await publications(db, draft.postId)) expect(p.scheduledFor.toISOString()).toBe('2026-11-05T08:00:00.000Z');

    setNow('2026-11-05T08:01:00.000Z');
    expect((await job.tick(new Date('2026-11-05T08:01:00.000Z'), { businessId })).ran).toBe(2);
    expect(run.networkPosts().map((p) => [p.network, p.scheduledFor]).sort()).toEqual([
      ['facebook', '2026-11-05T08:00:00.000Z'],
      ['instagram', '2026-11-05T08:00:00.000Z'],
    ]);
    expect(await db.postStatus(draft.postId)).toBe('published');
  });
});

e2eTest('the daily health check finds Facebook disconnected: the owner gets a template once and the team a console item', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async ({ run, db, app, publishing, businessId, setNow }) => {
    const { providerAccountId } = await publishing.getConnectionStatus({ businessId, network: 'facebook' });
    publishing.disconnect(providerAccountId!);

    setNow('2026-11-04T04:00:00.000Z');
    await app.channelHealth.tick(new Date('2026-11-04T04:00:00.000Z'), { businessId });
    await app.channelHealth.tick(new Date('2026-11-05T04:00:00.000Z'), { businessId });

    expect(templates(run).map((t) => t.template)).toEqual([
      { name: scheduleCopy.CHANNEL_DISCONNECTED_TEMPLATE, language: 'he', variables: { networks: 'פייסבוק' } },
    ]);
    const rows = await channels(db, businessId);
    expect(rows.find((c) => c.network === 'facebook')?.status).toBe('disconnected');
    expect(rows.find((c) => c.network === 'instagram')).toMatchObject({ status: 'verified', lastHealthCheckAt: expect.any(Date) });
    const items = (await consoleItems(db, businessId)).filter((i) => i.kind === 'channel_disconnected');
    run.recordConsoleItems(items.map((i) => ({ kind: i.kind, details: i.details })));
    expect(items).toHaveLength(1);
    expect(items[0]?.details).toMatchObject({ network: 'facebook', providerStatus: 'disconnected' });
  });
});

e2eTest("an unknown number's Change tap and change text change nothing and get no reply", { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async ({ run, world, db, messaging, businessId }) => {
    const draft = await world.createDraft(businessId, CAPTION);
    const before = run.owner.received().length;
    await world.app.deliverInbound(messaging.inboundButtonTap(STRANGER, { action: 'change', postId: draft.postId, versionHash: draft.versionHash }));
    await world.app.deliverInbound({ ...messaging.inbound(STRANGER, { kind: 'text', text: 'תשנו את המחיר ל-10 ₪' }), providerMessageId: `s-${crypto.randomUUID()}` });

    expect(await db.postStatus(draft.postId)).toBe('awaiting_approval');
    const versions = await read(db, (tx) => tx.select().from(schema.postVersion).where(eq(schema.postVersion.postId, draft.postId)));
    expect(versions.map((v) => v.contentHash)).toEqual([draft.versionHash]);
    expect(run.sender(STRANGER).received()).toEqual([]);
    expect(run.owner.received()).toHaveLength(before);
    const strangers = await read(db, (tx) =>
      tx.select({ kind: schema.consoleItem.kind }).from(schema.consoleItem).innerJoin(schema.message, eq(schema.message.id, schema.consoleItem.referenceId)).where(eq(schema.message.fromPhone, STRANGER)),
    );
    expect(strangers.length).toBeGreaterThanOrEqual(2);
    expect(new Set(strangers.map((s) => s.kind))).toEqual(new Set(['unknown_number']));
  });
});

e2eTest('the owner is told only once the provider reports the post live, not while it holds it scheduled', { timeout: 90_000 }, async ({ e2e }) => {
  await withBusiness(e2e, async ({ run, world, db, job, businessId, setNow }) => {
    const draft = await world.createDraft(businessId, CAPTION);
    await run.owner.tapsButton(draft.buttons.approve, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });
    await run.owner.sendsText('כן');

    // The job hands both publications to the provider ahead of time; the provider holds them scheduled.
    for (const p of await publications(db, draft.postId)) expect((await job.runPublication(p.id)).outcome).toBe('published');
    expect(await db.postStatus(draft.postId)).toBe('publishing');
    for (const p of await publications(db, draft.postId)) expect(p).toMatchObject({ status: 'published', publishedAt: null, providerPostId: expect.any(String) });
    expect(templates(run)).toEqual([]);

    setNow('2026-11-04T08:01:00.000Z');
    await job.tick(new Date('2026-11-04T08:01:00.000Z'), { businessId });
    expect(await db.postStatus(draft.postId)).toBe('published');
    for (const p of await publications(db, draft.postId)) expect(p.publishedAt?.toISOString()).toBe(PROPOSED);
    expect(templates(run).map((t) => t.template?.name)).toEqual([scheduleCopy.PUBLISHED_TEMPLATE]);
  });
});
