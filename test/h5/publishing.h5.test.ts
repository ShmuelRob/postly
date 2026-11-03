/**
 * H5 human-owned tests: the publishing guard and retries (state-machines.md, "Publishing guard" and
 * "Publication"). Written from the docs before WP-34. WP-34 may not edit these; a case it believes
 * is wrong is reported.
 */
import { afterEach, describe, expect } from 'vitest';
import { APPROVER, OTHER_APPROVER, SCHEDULED_FOR, UNKNOWN_HASH, businessWithDraft, setup, type Setup } from './fixtures.js';
import { h5It } from './world.js';

const it = h5It('publishing');
const DUE = '2026-11-04T08:01:00.000Z';
let s: Setup | undefined;
const open = async () => (s = await setup());
afterEach(async () => {
  await s?.world.close();
  s = undefined;
});

/** A draft approved by the approver and scheduled on both channels, with the clock past its time. */
async function scheduledPost(s: Setup, approver = APPROVER) {
  const { businessId, draft } = await businessWithDraft(s, approver);
  const decision = await s.world.approval.handleApprovalReply(
    businessId,
    s.messaging.inboundButtonTap(approver, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash }),
  );
  if (decision.outcome !== 'approved') throw new Error(`setup: approval refused (${decision.reason})`);
  const publications = await s.world.schedule(businessId, draft.postId, SCHEDULED_FOR);
  s.setNow(DUE);
  return { businessId, draft, approvalId: decision.approvalId, publications };
}

describe('H5 publishing: only an approved current version goes live', () => {
  it('a publication tied to the valid approval of the current version publishes exactly once per channel', async () => {
    const s = await open();
    const { publications } = await scheduledPost(s);
    expect(publications.map((p) => p.network).sort()).toEqual(['facebook', 'instagram']);

    for (const { publicationId } of publications) {
      expect((await s.world.publishingJob.runPublication(publicationId)).outcome).toBe('published');
      expect((await s.world.publicationStatus(publicationId)).status).toBe('published');
    }
    expect(s.publishing.posts.map((p) => p.request.idempotencyKey).sort()).toEqual(publications.map((p) => p.publicationId).sort());
    for (const post of s.publishing.posts) expect(post.request.caption).toBe('צבעונים חדשים הגיעו, 25 ₪ לזר');
  });

  it('a publication whose approval was invalidated by a new version is refused and reaches no network', async () => {
    const s = await open();
    const { businessId, draft, approvalId } = await scheduledPost(s);
    await s.world.requestChange(businessId, draft.postId, 'צבעונים חדשים הגיעו, 30 ₪ לזר');
    const forged = await s.world.forgePublication(businessId, {
      postId: draft.postId,
      approvalId,
      approvedVersionHash: draft.versionHash,
      network: 'instagram',
      scheduledFor: SCHEDULED_FOR,
    });

    const outcome = await s.world.publishingJob.runPublication(forged);

    expect(outcome.outcome).toBe('refused');
    expect(s.publishing.posts).toEqual([]);
  });

  it('a publication whose hash differs from its approval hash is refused', async () => {
    const s = await open();
    const { businessId, draft, approvalId } = await scheduledPost(s);
    const forged = await s.world.forgePublication(businessId, {
      postId: draft.postId,
      approvalId,
      approvedVersionHash: UNKNOWN_HASH,
      network: 'instagram',
      scheduledFor: SCHEDULED_FOR,
    });

    expect(await s.world.publishingJob.runPublication(forged)).toEqual({ outcome: 'refused', reason: 'not_approved' });
    expect(s.publishing.posts).toEqual([]);
  });

  it('a pending publication of a post changed after scheduling never publishes', async () => {
    const s = await open();
    const { businessId, draft, publications } = await scheduledPost(s);
    await s.world.requestChange(businessId, draft.postId, 'צבעונים חדשים הגיעו, 30 ₪ לזר');

    for (const { publicationId } of publications) {
      expect((await s.world.publishingJob.runPublication(publicationId)).outcome).toBe('refused');
    }
    expect(s.publishing.posts).toEqual([]);
  });

  it('a published publication is not published again', async () => {
    const s = await open();
    const { publications } = await scheduledPost(s);
    const [first] = publications;
    if (!first) throw new Error('setup: no publication');
    await s.world.publishingJob.runPublication(first.publicationId);

    expect(await s.world.publishingJob.runPublication(first.publicationId)).toEqual({ outcome: 'refused', reason: 'wrong_state' });
    expect(s.publishing.posts).toHaveLength(1);
  });
});

describe('H5 publishing: pauses and handoff defer', () => {
  const cases = [
    { name: 'the global pause', reason: 'global_pause', on: (s: Setup, _b: string) => s.world.setGlobalPause(true), off: (s: Setup, _b: string) => s.world.setGlobalPause(false) },
    { name: 'a business pause', reason: 'business_pause', on: (s: Setup, b: string) => s.world.setBusinessPaused(b, true), off: (s: Setup, b: string) => s.world.setBusinessPaused(b, false) },
    { name: 'a handoff', reason: 'handoff', on: (s: Setup, b: string) => s.world.setHandoff(b, true), off: (s: Setup, b: string) => s.world.setHandoff(b, false) },
  ] as const;

  for (const c of cases) {
    it(`${c.name} defers publishing without changing state, and it publishes once lifted`, async () => {
      const s = await open();
      const { businessId, publications } = await scheduledPost(s);
      const [first] = publications;
      if (!first) throw new Error('setup: no publication');
      await c.on(s, businessId);

      expect(await s.world.publishingJob.runPublication(first.publicationId)).toEqual({ outcome: 'deferred', reason: c.reason });
      expect((await s.world.publicationStatus(first.publicationId)).status).toBe('scheduled');
      expect(s.publishing.posts).toEqual([]);

      await c.off(s, businessId);
      expect((await s.world.publishingJob.runPublication(first.publicationId)).outcome).toBe('published');
      expect(s.publishing.posts).toHaveLength(1);
    });
  }
});

describe('H5 publishing: cross-business references', () => {
  it("a publication pointing at another business's approval never publishes", async () => {
    const s = await open();
    const a = await scheduledPost(s, APPROVER);
    const b = await businessWithDraft(s, OTHER_APPROVER);

    let forged: string | undefined;
    try {
      forged = await s.world.forgePublication(b.businessId, {
        postId: a.draft.postId,
        approvalId: a.approvalId,
        approvedVersionHash: a.draft.versionHash,
        network: 'instagram',
        scheduledFor: SCHEDULED_FOR,
      });
    } catch {
      // The database refusing the row (composite same-business keys, WP-24) is also a pass.
    }
    if (forged !== undefined) {
      expect(await s.world.publishingJob.runPublication(forged)).toEqual({ outcome: 'refused', reason: 'cross_business' });
    }
    expect(s.publishing.posts).toEqual([]);
  });
});

describe('H5 publishing: retries never double-publish', () => {
  it('a rejected attempt goes to retry_pending and the retry publishes once', async () => {
    const s = await open();
    const { publications } = await scheduledPost(s);
    const [first] = publications;
    if (!first) throw new Error('setup: no publication');
    s.publishing.failNextPublish({ mode: 'reject' });

    expect((await s.world.publishingJob.runPublication(first.publicationId)).outcome).toBe('retry_pending');
    expect(s.publishing.posts).toEqual([]);
    expect((await s.world.publishingJob.runPublication(first.publicationId)).outcome).toBe('published');
    expect(s.publishing.posts).toHaveLength(1);
  });

  it('after a lost response the retry finds the live post and does not create a second one', async () => {
    const s = await open();
    const { publications } = await scheduledPost(s);
    const [first] = publications;
    if (!first) throw new Error('setup: no publication');
    s.publishing.failNextPublish({ mode: 'reject_after_create' });

    expect((await s.world.publishingJob.runPublication(first.publicationId)).outcome).toBe('retry_pending');
    expect(s.publishing.posts).toHaveLength(1);

    const publishKeys: string[] = [];
    const publish = s.publishing.publish.bind(s.publishing);
    s.publishing.publish = async (request) => {
      publishKeys.push(request.idempotencyKey);
      return publish(request);
    };
    const retry = await s.world.publishingJob.runPublication(first.publicationId);
    // A retry may only reach publish with the publication id as the idempotency key.
    expect(publishKeys.every((key) => key === first.publicationId)).toBe(true);
    expect(['published', 'already_published']).toContain(retry.outcome);
    expect(s.publishing.posts).toHaveLength(1);
    expect((await s.world.publicationStatus(first.publicationId)).providerPostId).toBe(s.publishing.posts[0]?.providerPostId);
  });
});
