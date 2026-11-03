/**
 * H5 human-owned tests: the approval guard (state-machines.md, "Approval guard"; PRD approval rules).
 * Written from the docs before WP-33. WP-33 may not edit these; a case it believes is wrong is reported.
 */
import { afterEach, describe, expect } from 'vitest';
import { APPROVER, OTHER_APPROVER, SCHEDULED_FOR, STRANGER, UNKNOWN_HASH, businessWithDraft, setup, type Setup } from './fixtures.js';
import { h5It } from './world.js';

const it = h5It('approval');
let s: Setup | undefined;
const open = async () => (s = await setup());
afterEach(async () => {
  await s?.world.close();
  s = undefined;
});

describe('H5 approval: only a button press counts', () => {
  it('the approver tapping approve on the current version approves the post and records the hash', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    const tap = s.messaging.inboundButtonTap(APPROVER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });

    const decision = await s.world.approval.handleApprovalReply(businessId, tap);

    expect(decision.outcome).toBe('approved');
    expect(await s.world.postStatus(businessId, draft.postId)).toBe('approved');
    expect(await s.world.approvals(businessId, draft.postId)).toEqual([
      expect.objectContaining({ versionHash: draft.versionHash, invalidated: false }),
    ]);
  });

  for (const text of ['מאשר', 'אישור', 'ok', 'OK', '👍', 'מאשר ✅', 'approve', 'כן, מאשר את הפוסט']) {
    it(`free text "${text}" from the approver never approves`, async () => {
      const s = await open();
      const { businessId, draft } = await businessWithDraft(s);

      const decision = await s.world.approval.handleApprovalReply(businessId, s.messaging.inboundText(APPROVER, text));

      expect(decision).toEqual({ outcome: 'refused', reason: 'not_a_button' });
      expect(await s.world.postStatus(businessId, draft.postId)).toBe('awaiting_approval');
      expect(await s.world.approvals(businessId, draft.postId)).toEqual([]);
    });
  }

  it('a voice note or an image from the approver never approves', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);

    for (const message of [
      s.messaging.inboundVoice(APPROVER, 'voice-1'),
      s.messaging.inboundImage(APPROVER, 'image-1', 'מאשר'),
    ]) {
      expect(await s.world.approval.handleApprovalReply(businessId, message)).toEqual({ outcome: 'refused', reason: 'not_a_button' });
    }
    expect(await s.world.postStatus(businessId, draft.postId)).toBe('awaiting_approval');
    expect(await s.world.approvals(businessId, draft.postId)).toEqual([]);
  });

  it('a change button never approves', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    const tap = s.messaging.inboundButtonTap(APPROVER, { action: 'change', postId: draft.postId, versionHash: draft.versionHash });

    expect((await s.world.approval.handleApprovalReply(businessId, tap)).outcome).not.toBe('approved');
    expect(await s.world.postStatus(businessId, draft.postId)).not.toBe('approved');
    expect(await s.world.approvals(businessId, draft.postId)).toEqual([]);
  });
});

describe('H5 approval: only the business approver number', () => {
  it('an approve tap from any other number is refused', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    const tap = s.messaging.inboundButtonTap(STRANGER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });

    expect(await s.world.approval.handleApprovalReply(businessId, tap)).toEqual({ outcome: 'refused', reason: 'not_approver' });
    expect(await s.world.postStatus(businessId, draft.postId)).toBe('awaiting_approval');
    expect(await s.world.approvals(businessId, draft.postId)).toEqual([]);
  });

  it("another business's approver cannot approve this business's post", async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    await s.world.createBusiness(OTHER_APPROVER);
    const tap = s.messaging.inboundButtonTap(OTHER_APPROVER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });

    expect(await s.world.approval.handleApprovalReply(businessId, tap)).toEqual({ outcome: 'refused', reason: 'not_approver' });
    expect(await s.world.postStatus(businessId, draft.postId)).toBe('awaiting_approval');
  });
});

describe('H5 approval: bound to the exact version hash', () => {
  it('a button carrying a stale version hash is refused, and the current one approves', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    const changed = await s.world.requestChange(businessId, draft.postId, 'צבעונים חדשים הגיעו, 30 ₪ לזר');
    expect(changed.versionHash).not.toBe(draft.versionHash);

    const stale = s.messaging.inboundButtonTap(APPROVER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });
    expect(await s.world.approval.handleApprovalReply(businessId, stale)).toEqual({ outcome: 'refused', reason: 'stale_version' });
    expect(await s.world.approvals(businessId, draft.postId)).toEqual([]);

    const current = s.messaging.inboundButtonTap(APPROVER, { action: 'approve', postId: draft.postId, versionHash: changed.versionHash });
    expect((await s.world.approval.handleApprovalReply(businessId, current)).outcome).toBe('approved');
    expect(await s.world.approvals(businessId, draft.postId)).toEqual([
      expect.objectContaining({ versionHash: changed.versionHash, invalidated: false }),
    ]);
  });

  it('a hash that belongs to no version is refused', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    const tap = s.messaging.inboundButtonTap(APPROVER, { action: 'approve', postId: draft.postId, versionHash: UNKNOWN_HASH });

    expect(await s.world.approval.handleApprovalReply(businessId, tap)).toEqual({ outcome: 'refused', reason: 'stale_version' });
    expect(await s.world.postStatus(businessId, draft.postId)).toBe('awaiting_approval');
  });

  it('a second tap on an already approved post is refused and adds no approval', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    const tap = () => s.messaging.inboundButtonTap(APPROVER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });
    await s.world.approval.handleApprovalReply(businessId, tap());

    expect(await s.world.approval.handleApprovalReply(businessId, tap())).toEqual({ outcome: 'refused', reason: 'wrong_state' });
    expect(await s.world.approvals(businessId, draft.postId)).toHaveLength(1);
  });
});

describe('H5 approval: any new version invalidates', () => {
  it('a change after approval invalidates the approval and the post leaves approved', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    await s.world.approval.handleApprovalReply(
      businessId,
      s.messaging.inboundButtonTap(APPROVER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash }),
    );

    await s.world.requestChange(businessId, draft.postId, 'צבעונים חדשים הגיעו, 30 ₪ לזר');

    expect(await s.world.approvals(businessId, draft.postId)).toEqual([
      expect.objectContaining({ versionHash: draft.versionHash, invalidated: true }),
    ]);
    expect(await s.world.postStatus(businessId, draft.postId)).toBe('awaiting_approval');
  });

  it('a change after scheduling invalidates the approval and cancels the pending publications', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    await s.world.approval.handleApprovalReply(
      businessId,
      s.messaging.inboundButtonTap(APPROVER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash }),
    );
    const publications = await s.world.schedule(businessId, draft.postId, SCHEDULED_FOR);
    expect(publications).toHaveLength(2);

    await s.world.requestChange(businessId, draft.postId, 'צבעונים חדשים הגיעו, 30 ₪ לזר');

    expect((await s.world.approvals(businessId, draft.postId)).every((a) => a.invalidated)).toBe(true);
    for (const { publicationId } of publications) {
      expect((await s.world.publicationStatus(publicationId)).status).toBe('cancelled');
    }
  });
});

describe('H5 approval: cross-business references', () => {
  it("a business's own approver tapping a button with another business's post is refused", async () => {
    const s = await open();
    const a = await businessWithDraft(s, APPROVER);
    const bId = await s.world.createBusiness(OTHER_APPROVER);
    const tap = s.messaging.inboundButtonTap(OTHER_APPROVER, { action: 'approve', postId: a.draft.postId, versionHash: a.draft.versionHash });

    expect(await s.world.approval.handleApprovalReply(bId, tap)).toEqual({ outcome: 'refused', reason: 'unknown_post' });
    expect(await s.world.postStatus(a.businessId, a.draft.postId)).toBe('awaiting_approval');
    expect(await s.world.approvals(a.businessId, a.draft.postId)).toEqual([]);
  });
});
