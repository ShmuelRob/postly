import { and, eq, isNull } from 'drizzle-orm';
import type { ApprovalDecision, ApprovalRefusal, ApprovalService } from '../../contracts/approval.js';
import type { ApprovalButtonPayload, InboundMessage } from '../../contracts/providers/messaging.js';
import { postMachine } from '../../contracts/state-machines/index.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';

// The approval guard (state-machines.md, Approval guard; technical-design.md, Approval flow). Code
// only, no model: an approval exists only for a button tap from the business's approver number,
// carrying the hash of the post's current version, on a post awaiting approval.

/** A stored inbound message as the approval service reads it. */
export interface StoredTap {
  /** The `message` row id. */
  messageId: string;
  from: string;
  content: InboundMessage['content'];
}

export interface ApprovalsDeps {
  db: Database;
  /** False while a person handles the conversation (the approval role cannot read conversation_state). */
  mayAutoReply(businessId: string): Promise<boolean>;
  /** Stores an inbound message the app did not receive through messaging, and returns its row id. */
  recordInbound(businessId: string, message: InboundMessage): Promise<string>;
  /** Cancels the post's `scheduled` and `retry_pending` publications (publishing role). */
  cancelPendingPublications(businessId: string, postId: string): Promise<void>;
  now?: () => Date;
}

export interface Approvals extends ApprovalService {
  /** The same guard for a message messaging already stored. */
  handleStoredTap(businessId: string, tap: StoredTap): Promise<ApprovalDecision>;
  /**
   * Invalidates every valid approval of the post and cancels its pending publications. Called before
   * any new version is written and before a change leaves `approved` or `scheduled`.
   */
  invalidate(businessId: string, postId: string): Promise<void>;
}

const refused = (reason: ApprovalRefusal): ApprovalDecision => ({ outcome: 'refused', reason });

const isUniqueViolation = (error: unknown): boolean => {
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === '23505') return true;
  }
  return false;
};

export function createApprovals(deps: ApprovalsDeps): Approvals {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const approvedTo = (postMachine.transitions as Record<string, Record<string, string> | undefined>).awaiting_approval?.APPROVED;
  if (approvedTo !== 'approved') throw new Error('post machine: awaiting_approval --APPROVED--> approved is missing');

  const approverPhone = (businessId: string) =>
    db.withBusiness('approval', businessId, async (tx) => {
      const [row] = await tx.select({ phone: schema.business.approverPhone }).from(schema.business).where(eq(schema.business.id, businessId));
      return row?.phone;
    });

  /** The checks before anything is stored: a button, the approve action, the approver, no handoff. */
  async function precheck(businessId: string, from: string, content: InboundMessage['content']) {
    if (content.kind !== 'button_reply' || content.payload.action !== 'approve') return { refusal: refused('not_a_button') };
    const phone = await approverPhone(businessId);
    if (!phone || from !== phone) return { refusal: refused('not_approver') };
    if (!(await deps.mayAutoReply(businessId))) return { refusal: refused('handoff') };
    return { payload: content.payload, phone };
  }

  async function decide(businessId: string, messageId: string, phone: string, payload: ApprovalButtonPayload): Promise<ApprovalDecision> {
    try {
      return await db.withBusiness('approval', businessId, async (tx): Promise<ApprovalDecision> => {
        const a = schema.approval;
        const [post] = await tx
          .select({ status: schema.post.status, currentVersionId: schema.post.currentVersionId })
          .from(schema.post)
          .where(eq(schema.post.id, payload.postId))
          .for('update');
        const [seen] = await tx.select({ id: a.id }).from(a).where(eq(a.messageId, messageId));
        if (seen) return refused('duplicate');
        if (!post) return refused('unknown_post');
        const [current] = post.currentVersionId
          ? await tx
              .select({ id: schema.postVersion.id, hash: schema.postVersion.contentHash })
              .from(schema.postVersion)
              .where(and(eq(schema.postVersion.id, post.currentVersionId), eq(schema.postVersion.postId, payload.postId)))
          : [];
        if (!current || current.hash !== payload.versionHash) return refused('stale_version');
        if (post.status !== 'awaiting_approval') return refused('wrong_state');
        const at = now();
        const [row] = await tx
          .insert(a)
          .values({
            businessId,
            postId: payload.postId,
            postVersionId: current.id,
            approvedVersionHash: current.hash,
            approverPhone: phone,
            messageId,
            approvedAt: at,
          })
          .returning({ id: a.id });
        await tx.update(schema.post).set({ status: approvedTo as 'approved', updatedAt: at }).where(eq(schema.post.id, payload.postId));
        return { outcome: 'approved', approvalId: row!.id };
      });
    } catch (error) {
      // Another handling of the same message committed first (approval.message_id is unique).
      if (isUniqueViolation(error)) return refused('duplicate');
      throw error;
    }
  }

  return {
    async handleApprovalReply(businessId, message) {
      const checked = await precheck(businessId, message.from, message.content);
      if (checked.refusal) return checked.refusal;
      const messageId = await deps.recordInbound(businessId, message);
      return decide(businessId, messageId, checked.phone, checked.payload);
    },

    async handleStoredTap(businessId, tap) {
      const checked = await precheck(businessId, tap.from, tap.content);
      if (checked.refusal) return checked.refusal;
      return decide(businessId, tap.messageId, checked.phone, checked.payload);
    },

    async invalidate(businessId, postId) {
      await db.withBusiness('approval', businessId, (tx) =>
        tx
          .update(schema.approval)
          .set({ invalidatedAt: now() })
          .where(and(eq(schema.approval.postId, postId), isNull(schema.approval.invalidatedAt))),
      );
      await deps.cancelPendingPublications(businessId, postId);
    },
  };
}
