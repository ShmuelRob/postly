/**
 * H5 human-owned tests: the approval guard (state-machines.md, "Approval guard" and "Human handoff";
 * PRD approval rules). Written from the docs before WP-33. WP-33 may not edit these; a case it
 * believes is wrong is reported. State is read with the test-owned SQL in `db.ts`.
 */
import { afterEach, describe, expect } from 'vitest';
import { decodeButtonId, type ApprovalButtonPayload } from '../../src/contracts/providers/index.js';
import {
  APPROVER,
  CAPTION,
  CHANGED_CAPTION,
  OTHER_APPROVER,
  SCHEDULED_FOR,
  STRANGER,
  UNKNOWN_HASH,
  approve,
  businessWithDraft,
  setup,
  type Setup,
} from './fixtures.js';
import { h5It } from './world.js';

const it = h5It('approval');
let s: Setup | undefined;
const open = async () => (s = await setup());
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const tap = (s: Setup, from: string, payload: ApprovalButtonPayload) => s.messaging.inboundButtonTap(from, payload);

/** The post is still awaiting approval and has no approval row. */
async function unchanged(s: Setup, postId: string) {
  expect(await s.db.postStatus(postId)).toBe('awaiting_approval');
  expect(await s.db.approvals(postId)).toEqual([]);
}

describe('H5 approval: only a button press counts', () => {
  it('the approver tapping approve on the current version approves the post and records the hash', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);

    const decision = await s.world.approval.handleApprovalReply(
      businessId,
      tap(s, APPROVER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash }),
    );

    expect(decision.outcome).toBe('approved');
    expect(await s.db.postStatus(draft.postId)).toBe('approved');
    const approvals = await s.db.approvals(draft.postId);
    expect(approvals).toEqual([{ approvalId: expect.any(String), versionHash: draft.versionHash, invalidated: false, approverPhone: APPROVER }]);
    expect(decision.outcome === 'approved' && decision.approvalId).toBe(approvals[0]?.approvalId);
  });

  for (const text of ['מאשר', 'אישור', 'ok', 'OK', '👍', 'מאשר ✅', 'approve', 'כן, מאשר את הפוסט']) {
    it(`free text "${text}" from the approver never approves`, async () => {
      const s = await open();
      const { businessId, draft } = await businessWithDraft(s);

      const decision = await s.world.approval.handleApprovalReply(businessId, s.messaging.inboundText(APPROVER, text));

      expect(decision).toEqual({ outcome: 'refused', reason: 'not_a_button' });
      await unchanged(s, draft.postId);
    });
  }

  it('a voice note or an image from the approver never approves', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);

    for (const message of [s.messaging.inboundVoice(APPROVER, 'voice-1'), s.messaging.inboundImage(APPROVER, 'image-1', 'מאשר')]) {
      expect(await s.world.approval.handleApprovalReply(businessId, message)).toEqual({ outcome: 'refused', reason: 'not_a_button' });
    }
    await unchanged(s, draft.postId);
  });

  it('a change button never approves', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);

    const decision = await s.world.approval.handleApprovalReply(
      businessId,
      tap(s, APPROVER, { action: 'change', postId: draft.postId, versionHash: draft.versionHash }),
    );

    expect(decision.outcome).toBe('refused');
    expect(await s.db.postStatus(draft.postId)).not.toBe('approved');
    expect(await s.db.approvals(draft.postId)).toEqual([]);
  });
});

describe('H5 approval: only the business approver number', () => {
  it('an approve tap from any other number is refused', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);

    const decision = await s.world.approval.handleApprovalReply(
      businessId,
      tap(s, STRANGER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash }),
    );

    expect(decision).toEqual({ outcome: 'refused', reason: 'not_approver' });
    await unchanged(s, draft.postId);
  });

  it("another business's approver cannot approve this business's post", async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    await s.world.createBusiness(OTHER_APPROVER);

    const decision = await s.world.approval.handleApprovalReply(
      businessId,
      tap(s, OTHER_APPROVER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash }),
    );

    expect(decision).toEqual({ outcome: 'refused', reason: 'not_approver' });
    await unchanged(s, draft.postId);
  });
});

describe('H5 approval: bound to the exact version hash', () => {
  it('a button carrying a stale version hash is refused, and the current one approves', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    const changed = await s.world.requestChange(businessId, draft.postId, CHANGED_CAPTION);
    expect(changed.versionHash).not.toBe(draft.versionHash);

    const stale = await s.world.approval.handleApprovalReply(
      businessId,
      tap(s, APPROVER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash }),
    );
    expect(stale).toEqual({ outcome: 'refused', reason: 'stale_version' });
    await unchanged(s, draft.postId);

    await approve(s, businessId, draft.postId, changed.versionHash);
    expect(await s.db.approvals(draft.postId)).toEqual([expect.objectContaining({ versionHash: changed.versionHash, invalidated: false })]);
  });

  it('a hash that belongs to no version is refused', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);

    const decision = await s.world.approval.handleApprovalReply(
      businessId,
      tap(s, APPROVER, { action: 'approve', postId: draft.postId, versionHash: UNKNOWN_HASH }),
    );

    expect(decision).toEqual({ outcome: 'refused', reason: 'stale_version' });
    await unchanged(s, draft.postId);
  });

  it("the hash of another post's version in the same business is refused", async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    const other = await s.world.createDraft(businessId, 'מבצע סוף שבוע: 20% הנחה');

    const decision = await s.world.approval.handleApprovalReply(
      businessId,
      tap(s, APPROVER, { action: 'approve', postId: draft.postId, versionHash: other.versionHash }),
    );

    expect(decision).toEqual({ outcome: 'refused', reason: 'stale_version' });
    await unchanged(s, draft.postId);
    await unchanged(s, other.postId);
  });
});

describe('H5 approval: only a post awaiting approval', () => {
  it('a second tap on an already approved post is refused and adds no approval', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    await approve(s, businessId, draft.postId, draft.versionHash);

    const decision = await s.world.approval.handleApprovalReply(
      businessId,
      tap(s, APPROVER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash }),
    );

    expect(decision).toEqual({ outcome: 'refused', reason: 'wrong_state' });
    expect(await s.db.approvals(draft.postId)).toHaveLength(1);
    expect(await s.db.postStatus(draft.postId)).toBe('approved');
  });

  it('a tap on a scheduled post is refused and adds no approval', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    await approve(s, businessId, draft.postId, draft.versionHash);
    await s.world.schedule(businessId, draft.postId, SCHEDULED_FOR);

    const decision = await s.world.approval.handleApprovalReply(
      businessId,
      tap(s, APPROVER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash }),
    );

    expect(decision).toEqual({ outcome: 'refused', reason: 'wrong_state' });
    expect(await s.db.approvals(draft.postId)).toHaveLength(1);
    expect(await s.db.postStatus(draft.postId)).toBe('scheduled');
  });

  it('a tap on a cancelled post is refused and adds no approval', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    await s.world.cancelPost(businessId, draft.postId);

    const decision = await s.world.approval.handleApprovalReply(
      businessId,
      tap(s, APPROVER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash }),
    );

    expect(decision).toEqual({ outcome: 'refused', reason: 'wrong_state' });
    expect(await s.db.approvals(draft.postId)).toEqual([]);
    expect(await s.db.postStatus(draft.postId)).toBe('cancelled');
  });
});

describe('H5 approval: a tap is never counted twice', () => {
  it('the same inbound message handled twice yields one approval, and the second is refused as a duplicate', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    const message = tap(s, APPROVER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });

    expect((await s.world.approval.handleApprovalReply(businessId, message)).outcome).toBe('approved');
    expect(await s.world.approval.handleApprovalReply(businessId, message)).toEqual({ outcome: 'refused', reason: 'duplicate' });
    expect(await s.db.approvals(draft.postId)).toHaveLength(1);
  });

  it('two taps handled at the same time yield exactly one approval', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    const payload = { action: 'approve', postId: draft.postId, versionHash: draft.versionHash } as const;

    const decisions = await Promise.all([
      s.world.approval.handleApprovalReply(businessId, tap(s, APPROVER, payload)),
      s.world.approval.handleApprovalReply(businessId, tap(s, APPROVER, payload)),
    ]);

    expect(decisions.filter((d) => d.outcome === 'approved')).toHaveLength(1);
    expect(await s.db.approvals(draft.postId)).toHaveLength(1);
  });
});

describe('H5 approval: handoff applies no events', () => {
  it('an approve tap during handoff is refused and changes nothing', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    await s.db.setHandoff(businessId, true);

    const decision = await s.world.approval.handleApprovalReply(
      businessId,
      tap(s, APPROVER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash }),
    );

    expect(decision).toEqual({ outcome: 'refused', reason: 'handoff' });
    await unchanged(s, draft.postId);
  });
});

describe('H5 approval: any new version invalidates', () => {
  it('a change after approval invalidates the approval and the post leaves approved', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    await approve(s, businessId, draft.postId, draft.versionHash);

    await s.world.requestChange(businessId, draft.postId, CHANGED_CAPTION);

    expect(await s.db.approvals(draft.postId)).toEqual([expect.objectContaining({ versionHash: draft.versionHash, invalidated: true })]);
    expect(await s.db.postStatus(draft.postId)).toBe('awaiting_approval');
  });

  it('a change after scheduling invalidates the approval and cancels the pending publications', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    await approve(s, businessId, draft.postId, draft.versionHash);
    const publications = await s.world.schedule(businessId, draft.postId, SCHEDULED_FOR);
    expect(publications.map((p) => p.network).sort()).toEqual(['facebook', 'instagram']);

    await s.world.requestChange(businessId, draft.postId, CHANGED_CAPTION);

    expect(await s.db.approvals(draft.postId)).toEqual([expect.objectContaining({ invalidated: true })]);
    for (const { publicationId } of publications) {
      expect((await s.db.publication(publicationId))?.status).toBe('cancelled');
    }
  });
});

describe('H5 approval: cross-business references', () => {
  it("a business's own approver tapping a button with another business's post is refused", async () => {
    const s = await open();
    const a = await businessWithDraft(s, APPROVER, CAPTION);
    const bId = await s.world.createBusiness(OTHER_APPROVER);

    const decision = await s.world.approval.handleApprovalReply(
      bId,
      tap(s, OTHER_APPROVER, { action: 'approve', postId: a.draft.postId, versionHash: a.draft.versionHash }),
    );

    expect(decision).toEqual({ outcome: 'refused', reason: 'unknown_post' });
    await unchanged(s, a.draft.postId);
  });
});

/**
 * T15 (human decision 2026-11-04): a button sent for a version that was later replaced never
 * approves, even when the current version has the same content hash. A real revert of the caption
 * does not reproduce the hash today (every redraft stores new rendered media ids, and the hash covers
 * them), so a plain case pins that down and the stale-button cases force a later version with the
 * same hash through test-owned SQL (`forgeSameHashVersion`). The tap replays the approve button
 * exactly as it was sent, so the cases hold whatever the button id carries. Until the T15 fix lands
 * the two stale-button cases run as `it.fails`; the fix PR turns them into `it`.
 */
describe("H5 approval: a replaced version's button never approves, even with the same hash", () => {
  const pendingT15 = it.fails as typeof it;

  /** The approve button of the last buttons message sent to the approver, replayed as the approver's tap. */
  function lastApproveButton(s: Setup, draft: { buttons: { approve: string } }) {
    const message = s.messaging
      .sentTo(APPROVER)
      .filter((m) => m.kind === 'buttons')
      .at(-1);
    if (message?.kind !== 'buttons') throw new Error('setup: no buttons were sent to the approver');
    const button = message.request.buttons.find((b) => b.title === draft.buttons.approve);
    if (!button) throw new Error('setup: the draft was sent without its approve button');
    const payload = decodeButtonId(button.id);
    if (!payload) throw new Error(`setup: the approve button id "${button.id}" does not decode`);
    return () => s.messaging.inbound(APPROVER, { kind: 'button_reply', buttonId: button.id, payload });
  }

  it('a real caption revert yields a new hash, so the first button is refused as stale', async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    const firstButton = lastApproveButton(s, draft);
    await s.world.requestChange(businessId, draft.postId, CHANGED_CAPTION);
    const reverted = await s.world.requestChange(businessId, draft.postId, CAPTION);
    expect(reverted.versionHash).not.toBe(draft.versionHash);

    expect(await s.world.approval.handleApprovalReply(businessId, firstButton())).toEqual({ outcome: 'refused', reason: 'stale_version' });
    await unchanged(s, draft.postId);
  }, 60_000);

  pendingT15("the first version's button is refused when a later version has the same hash", async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    const firstButton = lastApproveButton(s, draft);
    await s.db.forgeSameHashVersion(draft.postId);

    const decision = await s.world.approval.handleApprovalReply(businessId, firstButton());

    expect(decision).toEqual({ outcome: 'refused', reason: 'stale_version' });
    await unchanged(s, draft.postId);
  });

  pendingT15("an approved first version's button, replayed after a same-hash version replaced it, is refused", async () => {
    const s = await open();
    const { businessId, draft } = await businessWithDraft(s);
    const firstButton = lastApproveButton(s, draft);
    expect((await s.world.approval.handleApprovalReply(businessId, firstButton())).outcome).toBe('approved');
    await s.db.forgeSameHashVersion(draft.postId);

    const decision = await s.world.approval.handleApprovalReply(businessId, firstButton());

    expect(decision).toEqual({ outcome: 'refused', reason: 'stale_version' });
    expect(await s.db.postStatus(draft.postId)).toBe('awaiting_approval');
    expect(await s.db.approvals(draft.postId)).toEqual([expect.objectContaining({ versionHash: draft.versionHash, invalidated: true })]);
  });
});
