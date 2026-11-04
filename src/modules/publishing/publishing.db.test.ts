import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, inject, it } from 'vitest';
import { BusinessProfile } from '../../contracts/business-profile.js';
import { createDatabase } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { MessagingSimulator, PublishingSimulator } from '../../simulators/index.js';
import { createH5World, type H5World } from '../../../test/h5/world.js';
import { createWorkflow } from '../workflow/index.js';
import { subjectApp } from '../../../test/h5/subject.js';
import { createChannels, createPublishingJob, type ApplyPublishingEvent } from './index.js';

// WP-34 (technical-design.md, Scheduling and publishing flow): the channel test validates a schedule
// and publishes nothing; the schedule conversation hands time changes and missing channels to a person.
// The H5 world (test/h5/subject.ts) builds the real app on the simulators.

const APPROVER = '+972501233461';
const db = createDatabase(inject('databaseUrls'), { max: 3 });
let world: H5World | undefined;
let publishing: PublishingSimulator;
let messaging: MessagingSimulator;
const NOW = new Date('2026-11-03T08:00:00.000Z');

async function open() {
  messaging = new MessagingSimulator();
  publishing = new PublishingSimulator({ now: () => NOW });
  world = await createH5World({ messaging, publishing, now: () => NOW, databaseUrls: inject('databaseUrls') });
  return world;
}
afterAll(() => db.close());
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const read = <T>(fn: Parameters<typeof db.withSystem<T>>[1]) => db.withSystem('console', fn);
const step = async (businessId: string) =>
  (await read((tx) => tx.select({ step: schema.conversationState.step, handoffAt: schema.conversationState.handoffAt }).from(schema.conversationState).where(eq(schema.conversationState.businessId, businessId))))[0];
const items = (businessId: string) => read((tx) => tx.select().from(schema.consoleItem).where(eq(schema.consoleItem.businessId, businessId)));
const tap = (postId: string, versionHash: string) => messaging.inboundButtonTap(APPROVER, { action: 'approve', postId, versionHash });
const text = (t: string) => ({ ...messaging.inbound(APPROVER, { kind: 'text', text: t }), providerMessageId: `t-${crypto.randomUUID()}` });

describe('the channel test (state-machines.md, Channel connection)', { timeout: 30_000 }, () => {
  it('a failed test schedule leaves the channel unverified and pending, publishes nothing, and passes on the next try', async () => {
    const w = await open();
    const businessId = await w.createBusiness(APPROVER);
    const workflow = createWorkflow(db);
    const channels = createChannels({ db, provider: publishing, apply: (b, r) => workflow.apply(b, r) });
    await channels.requestLink(businessId, ['instagram']);
    publishing.connect(businessId, 'instagram');
    publishing.failNextTestSchedule('no publishing permission');

    expect(await channels.checkAndTest(businessId)).toEqual([{ network: 'instagram', status: 'pending' }]);
    expect(await channels.checkAndTest(businessId)).toEqual([{ network: 'instagram', status: 'verified' }]);
    expect(publishing.scheduleTests).toHaveLength(2);
    expect(publishing.posts).toEqual([]);
  });
});

describe('the schedule conversation (technical-design.md, Scheduling and publishing flow)', { timeout: 30_000 }, () => {
  async function confirming(w: H5World) {
    const businessId = await w.createBusiness(APPROVER);
    await w.connectChannel(businessId, 'instagram');
    await w.connectChannel(businessId, 'facebook');
    const draft = await w.createDraft(businessId, 'צבעונים חדשים הגיעו, 25 ₪ לזר');
    await w.app.deliverInbound(tap(draft.postId, draft.versionHash));
    expect((await step(businessId))?.step).toBe('confirming_schedule');
    return { businessId, draft };
  }

  it('any other answer to the proposed times goes to a person and schedules nothing', async () => {
    const w = await open();
    const { businessId, draft } = await confirming(w);
    await w.app.deliverInbound(text('אפשר ביום שני בבוקר?'));

    expect((await step(businessId))?.handoffAt).not.toBeNull();
    expect((await items(businessId)).map((i) => [i.kind, (i.details as { reason?: string }).reason])).toContainEqual(['handoff', 'schedule change requested']);
    expect(await read((tx) => tx.select().from(schema.publication).where(eq(schema.publication.postId, draft.postId)))).toEqual([]);
  });

  it('a channel that dropped before the confirmation: the owner is told, the team gets an item, nothing is scheduled', async () => {
    const w = await open();
    const { businessId, draft } = await confirming(w);
    await read((tx) =>
      tx
        .update(schema.channelConnection)
        .set({ status: 'disconnected' })
        .where(and(eq(schema.channelConnection.businessId, businessId), eq(schema.channelConnection.network, 'facebook'))),
    );
    await w.app.deliverInbound(text('כן'));

    expect(messaging.sent.at(-1)?.request).toMatchObject({ text: expect.stringContaining('פייסבוק לא מחובר') });
    expect((await items(businessId)).map((i) => i.kind)).toEqual(expect.arrayContaining(['channel_disconnected', 'handoff']));
    expect(await read((tx) => tx.select().from(schema.publication).where(eq(schema.publication.postId, draft.postId)))).toEqual([]);
    const [business] = await read((tx) => tx.select({ profile: schema.business.profile }).from(schema.business).where(eq(schema.business.id, businessId)));
    expect(BusinessProfile.parse(business!.profile).channels).toEqual(['instagram', 'facebook']);
  });
});

describe('the publishing job ends every error in a defined state (WP-35, review of PR #50)', { timeout: 30_000 }, () => {
  /** A scheduled post on Instagram and a job whose `apply` fails the named events once. */
  async function scheduled(failOnce: string[]) {
    const w = await open();
    const businessId = await w.createBusiness(APPROVER);
    await w.connectChannel(businessId, 'instagram');
    const draft = await w.createDraft(businessId, 'צבעונים חדשים הגיעו, 25 ₪ לזר');
    await w.app.deliverInbound(tap(draft.postId, draft.versionHash));
    const [pub] = await w.schedule(businessId, draft.postId, '2026-11-04T08:00:00.000Z');
    const app = subjectApp(w);
    const failing = new Set(failOnce);
    const apply: ApplyPublishingEvent = async (b, r) => {
      if (failing.delete(r.event)) throw new Error(`${r.event} lost`);
      return app.workflow.apply(b, r);
    };
    const calls: string[] = [];
    const status = publishing.getPublicationStatus.bind(publishing);
    publishing.getPublicationStatus = async (id) => (calls.push(`status:${id}`), status(id));
    const publish = publishing.publish.bind(publishing);
    publishing.publish = async (r) => (calls.push('publish'), publish(r));
    const job = createPublishingJob({ db, provider: publishing, apply, mayAutoReply: async () => true, urlFor: (path) => `https://media.test/${path}`, notify: async () => {}, now: () => NOW });
    const row = async () => (await read((tx) => tx.select().from(schema.publication).where(eq(schema.publication.id, pub!.publicationId))))[0]!;
    return { businessId, job, calls, row, publicationId: pub!.publicationId };
  }

  it('stores the provider id as soon as publish returns, so a retry after a lost SUCCEEDED checks the provider and does not publish again', async () => {
    const s = await scheduled(['SUCCEEDED']);
    expect((await s.job.runPublication(s.publicationId)).outcome).toBe('retry_pending');
    const after = await s.row();
    expect(after).toMatchObject({ status: 'retry_pending', providerPostId: publishing.posts[0]!.providerPostId });
    expect((await items(s.businessId)).filter((i) => i.kind === 'publication_failed')).toHaveLength(1);

    const retry = await s.job.runPublication(s.publicationId);
    expect(retry).toEqual({ outcome: 'already_published', providerPostId: after.providerPostId });
    // The retry asks the provider before anything else and never publishes again.
    expect(s.calls[1]).toBe(`status:${after.providerPostId}`);
    expect(s.calls.filter((c) => c === 'publish')).toHaveLength(1);
    expect(publishing.posts).toHaveLength(1);
  });

  it('a retry that finds the provider post failed ends the publication: it never publishes the same failed post as published (review of PR #52, item a)', async () => {
    const s = await scheduled(['SUCCEEDED']);
    publishing.failNextPublish({ mode: 'fail_status', error: 'media rejected' });
    // The first attempt hands the post to the provider, which accepts it and then reports it failed.
    expect((await s.job.runPublication(s.publicationId)).outcome).toBe('retry_pending');
    const providerPostId = (await s.row()).providerPostId;
    expect(providerPostId).toEqual(publishing.posts[0]!.providerPostId);

    // Attempt 2 of 3, yet the publication fails for good: the same idempotency key would return the same failed post.
    expect(await s.job.runPublication(s.publicationId)).toEqual({ outcome: 'failed', error: 'media rejected' });
    expect(await s.row()).toMatchObject({ status: 'failed', attempts: 2, providerPostId, lastError: 'media rejected' });
    expect(s.calls.filter((c) => c === 'publish')).toHaveLength(1);

    // A console retry ends the same way; it never reports the failed post as published.
    await read((tx) => tx.update(schema.publication).set({ status: 'retry_pending' }).where(eq(schema.publication.id, s.publicationId)));
    expect((await s.job.runPublication(s.publicationId)).outcome).toBe('failed');
    expect((await s.row()).status).toBe('failed');
    expect(s.calls.filter((c) => c === 'publish')).toHaveLength(1);
    expect((await items(s.businessId)).filter((i) => i.kind === 'publication_failed' && i.status === 'open')).toHaveLength(1);
  });

  it('a post the provider drops after accepting it resolves, with one console item, even when its sibling finishes later (review of PR #52, item b)', async () => {
    const w = await open();
    const businessId = await w.createBusiness(APPROVER);
    await w.connectChannel(businessId, 'instagram');
    await w.connectChannel(businessId, 'facebook');
    const draft = await w.createDraft(businessId, 'צבעונים חדשים הגיעו, 25 ₪ לזר');
    await w.app.deliverInbound(tap(draft.postId, draft.versionHash));
    // A time already passed, so the provider holds each post live as soon as it accepts it.
    const pubs = await w.schedule(businessId, draft.postId, '2026-11-03T07:00:00.000Z');
    const app = subjectApp(w);
    const notices: unknown[] = [];
    const job = createPublishingJob({
      db,
      provider: publishing,
      apply: (b, r) => app.workflow.apply(b, r),
      mayAutoReply: async () => true,
      urlFor: (path) => `https://media.test/${path}`,
      notify: async (_b, n) => void notices.push(n),
      now: () => NOW,
    });
    // The provider accepts the first post and then reports it failed; the second goes live.
    publishing.failNextPublish({ mode: 'fail_status', error: 'removed by the network' });
    const [first, second] = pubs;
    expect((await job.runPublication(first!.publicationId)).outcome).toBe('published');
    expect((await job.runPublication(second!.publicationId)).outcome).toBe('published');
    // Later ticks (the settle sweep) add nothing.
    await job.tick(NOW, { businessId });
    await job.tick(NOW, { businessId });

    const [post] = await read((tx) => tx.select({ status: schema.post.status }).from(schema.post).where(eq(schema.post.id, draft.postId)));
    expect(post?.status).toBe('partially_published');
    expect(notices).toEqual([{ kind: 'failed', postId: draft.postId, published: [second!.network], failed: [first!.network] }]);
    const failedItems = (await items(businessId)).filter((i) => i.kind === 'publication_failed');
    expect(failedItems.map((i) => i.referenceId)).toEqual([first!.publicationId]);
  });

  it('an error after STARTED and before the provider call ends in retry_pending with a console item, not in_progress', async () => {
    const s = await scheduled(['PUBLISHING_STARTED']);
    expect((await s.job.runPublication(s.publicationId)).outcome).toBe('retry_pending');
    expect(await s.row()).toMatchObject({ status: 'retry_pending', attempts: 1, lastError: 'PUBLISHING_STARTED lost' });
    expect(s.calls).toEqual([]);
    expect((await items(s.businessId)).filter((i) => i.kind === 'publication_failed').map((i) => i.details)).toEqual([expect.objectContaining({ internal: true })]);
  });

  it('a run that could not even record its failure is swept by the tick after 10 minutes', async () => {
    const s = await scheduled(['PUBLISHING_STARTED', 'ATTEMPT_FAILED']);
    await expect(s.job.runPublication(s.publicationId)).rejects.toThrow();
    expect((await s.row()).status).toBe('in_progress');
    const at = new Date((await s.row()).updatedAt.getTime() + 11 * 60_000);
    await s.job.tick(at, { businessId: s.businessId });
    expect(await s.row()).toMatchObject({ status: 'retry_pending', lastError: 'attempt interrupted' });
    expect((await items(s.businessId)).filter((i) => i.kind === 'publication_failed')).toHaveLength(1);
  });
});
