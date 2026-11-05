/**
 * H5 human-owned tests: the publishing guard and retries (state-machines.md, "Publishing guard" and
 * "Publication"). Written from the docs before WP-34. WP-34 may not edit these; a case it believes
 * is wrong is reported. State is read and forced with the test-owned SQL in `db.ts`.
 */
import { afterEach, describe, expect, it as passingIt } from 'vitest';
import type { Network } from '../../src/contracts/common.js';
import {
  APPROVER,
  CAPTION,
  CHANGED_CAPTION,
  DUE,
  OTHER_APPROVER,
  SCHEDULED_FOR,
  UNKNOWN_HASH,
  approve,
  businessWithDraft,
  setup,
  type Setup,
} from './fixtures.js';
import { h5It } from './world.js';

const it = h5It('publishing');
let s: Setup | undefined;
const open = async () => (s = await setup());
afterEach(async () => {
  await s?.close();
  s = undefined;
});

/** A draft approved by the approver and scheduled on both channels, with the clock past its time. */
async function scheduledPost(s: Setup, approver = APPROVER) {
  const { businessId, draft } = await businessWithDraft(s, approver);
  const approvalId = await approve(s, businessId, draft.postId, draft.versionHash, approver);
  const publications = await s.world.schedule(businessId, draft.postId, SCHEDULED_FOR);
  s.setNow(DUE);
  const first = publications.find((p) => p.network === 'instagram');
  if (!first) throw new Error('setup: no instagram publication');
  return { businessId, draft, approvalId, publications, first };
}

/** An approved but unscheduled draft, so forged rows do not collide with real publications. */
async function approvedPost(s: Setup) {
  const { businessId, draft } = await businessWithDraft(s);
  const approvalId = await approve(s, businessId, draft.postId, draft.versionHash);
  s.setNow(DUE);
  return { businessId, draft, approvalId };
}

const forge = (s: Setup, businessId: string, postId: string, approvalId: string, approvedVersionHash: string, network: Network = 'instagram') =>
  s.db.forgePublication({ businessId, postId, approvalId, approvedVersionHash, network, scheduledFor: SCHEDULED_FOR });

/** The publication is refused for `reason`, stays as it was, and nothing reached the provider. */
async function refused(s: Setup, publicationId: string, reason: string, status = 'scheduled') {
  expect(await s.world.publishingJob.runPublication(publicationId)).toEqual({ outcome: 'refused', reason });
  expect((await s.db.publication(publicationId))?.status).toBe(status);
  expect(s.publishing.posts).toEqual([]);
}

describe('H5 publishing: only an approved current version goes live', () => {
  it('a publication tied to the valid approval of the current version publishes exactly once per channel', async () => {
    const s = await open();
    const { publications } = await scheduledPost(s);

    for (const { publicationId } of publications) {
      const outcome = await s.world.publishingJob.runPublication(publicationId);
      expect(outcome.outcome).toBe('published');
      const row = await s.db.publication(publicationId);
      expect(row?.status).toBe('published');
      expect(outcome.outcome === 'published' && outcome.providerPostId).toBe(row?.providerPostId);
    }
    expect(s.publishing.posts.map((p) => p.request.idempotencyKey).sort()).toEqual(publications.map((p) => p.publicationId).sort());
    for (const post of s.publishing.posts) expect(post.request.caption).toBe(CAPTION);
  });

  it('a publication whose approval was invalidated by a new version is refused', async () => {
    const s = await open();
    const { businessId, draft, approvalId } = await approvedPost(s);
    await s.world.requestChange(businessId, draft.postId, CHANGED_CAPTION);
    const forged = await forge(s, businessId, draft.postId, approvalId, draft.versionHash);

    await refused(s, forged, 'not_approved');
  });

  it('a publication whose hash differs from its approval hash is refused', async () => {
    const s = await open();
    const { businessId, draft, approvalId } = await approvedPost(s);
    const forged = await forge(s, businessId, draft.postId, approvalId, UNKNOWN_HASH);

    await refused(s, forged, 'not_approved');
  });

  it("a publication using another post's approval in the same business is refused", async () => {
    const s = await open();
    const { businessId, approvalId, draft } = await approvedPost(s);
    const other = await s.world.createDraft(businessId, 'מבצע סוף שבוע: 20% הנחה');
    const forged = await forge(s, businessId, other.postId, approvalId, draft.versionHash);

    await refused(s, forged, 'not_current_version');
  });

  it('a pending publication of a post changed after scheduling is refused', async () => {
    const s = await open();
    const { businessId, draft, publications } = await scheduledPost(s);
    await s.world.requestChange(businessId, draft.postId, CHANGED_CAPTION);

    for (const { publicationId } of publications) await refused(s, publicationId, 'wrong_state', 'cancelled');
  });

  it('a published publication is not published again', async () => {
    const s = await open();
    const { first } = await scheduledPost(s);
    await s.world.publishingJob.runPublication(first.publicationId);

    expect(await s.world.publishingJob.runPublication(first.publicationId)).toEqual({ outcome: 'refused', reason: 'wrong_state' });
    expect(s.publishing.posts).toHaveLength(1);
    expect((await s.db.publication(first.publicationId))?.status).toBe('published');
  });
});

describe('H5 publishing: pauses and handoff defer', () => {
  const cases = [
    { name: 'the global pause', reason: 'global_pause', set: (s: Setup, _b: string, on: boolean) => s.db.setGlobalPause(on) },
    { name: 'a business pause', reason: 'business_pause', set: (s: Setup, b: string, on: boolean) => s.db.setBusinessPaused(b, on) },
    { name: 'a handoff', reason: 'handoff', set: (s: Setup, b: string, on: boolean) => s.db.setHandoff(b, on) },
  ] as const;

  for (const c of cases) {
    it(`${c.name} defers publishing without changing state, and it publishes once lifted`, async () => {
      const s = await open();
      const { businessId, first } = await scheduledPost(s);
      await c.set(s, businessId, true);

      expect(await s.world.publishingJob.runPublication(first.publicationId)).toEqual({ outcome: 'deferred', reason: c.reason });
      expect(await s.db.publication(first.publicationId)).toEqual(expect.objectContaining({ status: 'scheduled', attempts: 0 }));
      expect(s.publishing.posts).toEqual([]);

      await c.set(s, businessId, false);
      expect((await s.world.publishingJob.runPublication(first.publicationId)).outcome).toBe('published');
      expect(s.publishing.posts).toHaveLength(1);
    });
  }
});

describe('H5 publishing: cross-business references', () => {
  // Passes before WP-34: the database refuses the forged row (WP-24). Human-approved 2026-11-04 (PR #48).
  passingIt("a publication pointing at another business's approval never publishes", async () => {
    const s = await open();
    const a = await approvedPost(s);
    const b = await businessWithDraft(s, OTHER_APPROVER);
    // Both businesses: a forged row carries one of them. Other test files insert publications too.
    const count = () => s.db.publicationCount([a.businessId, b.businessId]);
    const before = await count();

    let forged: string | undefined;
    try {
      forged = await forge(s, b.businessId, a.draft.postId, a.approvalId, a.draft.versionHash);
    } catch {
      // The database refusing the row (composite same-business keys, WP-24) is also a pass.
    }
    if (forged === undefined) expect(await count()).toBe(before);
    else await refused(s, forged, 'cross_business');
    expect(s.publishing.posts).toEqual([]);
  });
});

describe('H5 publishing: retries never double-publish', () => {
  it('a rejected attempt goes to retry_pending and the retry publishes once', async () => {
    const s = await open();
    const { first } = await scheduledPost(s);
    s.publishing.failNextPublish({ mode: 'reject' });

    expect((await s.world.publishingJob.runPublication(first.publicationId)).outcome).toBe('retry_pending');
    expect((await s.db.publication(first.publicationId))?.status).toBe('retry_pending');
    expect(s.publishing.posts).toEqual([]);
    expect((await s.world.publishingJob.runPublication(first.publicationId)).outcome).toBe('published');
    expect(s.publishing.posts).toHaveLength(1);
  });

  it('after a lost response the retry reuses the publication id and leaves one post', async () => {
    const s = await open();
    const { first } = await scheduledPost(s);
    s.publishing.failNextPublish({ mode: 'reject_after_create' });
    expect((await s.world.publishingJob.runPublication(first.publicationId)).outcome).toBe('retry_pending');
    const keys: string[] = [];
    const publish = s.publishing.publish.bind(s.publishing);
    s.publishing.publish = async (request) => {
      keys.push(request.idempotencyKey);
      return publish(request);
    };

    const retry = await s.world.publishingJob.runPublication(first.publicationId);

    expect(['published', 'already_published']).toContain(retry.outcome);
    expect(keys.every((key) => key === first.publicationId)).toBe(true);
    expect(s.publishing.posts).toHaveLength(1);
    expect((await s.db.publication(first.publicationId))?.providerPostId).toBe(s.publishing.posts[0]?.providerPostId);
  });

  it('a retry with a known provider post checks its status first and does not publish again', async () => {
    const s = await open();
    const { first, businessId } = await scheduledPost(s);
    // The provider accepted the post, the job stored its id, then crashed before marking it published.
    const { providerAccountId } = await s.publishing.getConnectionStatus({ businessId, network: 'instagram' });
    const { providerPostId } = await s.publishing.publish({
      idempotencyKey: first.publicationId,
      providerAccountId: providerAccountId ?? '',
      network: 'instagram',
      caption: CAPTION,
      mediaUrls: ['https://storage.example.test/renders/instagram-1.png'],
      format: 'single',
      scheduledFor: SCHEDULED_FOR,
    });
    await s.db.markRetryPending(first.publicationId, providerPostId);
    const calls: string[] = [];
    const publish = s.publishing.publish.bind(s.publishing);
    const status = s.publishing.getPublicationStatus.bind(s.publishing);
    s.publishing.publish = async (request) => {
      calls.push('publish');
      return publish(request);
    };
    s.publishing.getPublicationStatus = async (id) => {
      calls.push(`status:${id}`);
      return status(id);
    };

    const retry = await s.world.publishingJob.runPublication(first.publicationId);

    expect(calls[0]).toBe(`status:${providerPostId}`);
    expect(calls).not.toContain('publish');
    expect(retry).toEqual({ outcome: 'already_published', providerPostId });
    expect(await s.db.publication(first.publicationId)).toEqual(expect.objectContaining({ status: 'published', providerPostId }));
    expect(s.publishing.posts).toHaveLength(1);
  });
});
