import { z } from 'zod';
import { Uuid } from './common.js';
import type { InboundMessage } from './providers/messaging.js';

/**
 * The narrow surfaces of the approval guard and the publishing guard (state-machines.md). The
 * approval and publishing modules (WP-33, WP-34) implement them; the human-owned H5 tests in
 * `test/h5/` pin their behavior. contracts.md, "Approval and publishing", is the source.
 */

export const ApprovalRefusal = z.enum([
  /** Free text, voice, an image, or anything that is not a button tap. */
  'not_a_button',
  /** The sender is not `business.approver_phone`. */
  'not_approver',
  /** The post does not exist for this business, including another business's post. */
  'unknown_post',
  /** The button's version hash is not the hash of the post's current version. */
  'stale_version',
  /** The post is not in `awaiting_approval`. */
  'wrong_state',
  /** The business's conversation is in handoff, so no event is applied from inbound messages. */
  'handoff',
  /** This inbound message (same provider message id) was already handled. */
  'duplicate',
]);
export type ApprovalRefusal = z.infer<typeof ApprovalRefusal>;

export const ApprovalDecision = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('approved'), approvalId: Uuid }),
  z.object({ outcome: z.literal('refused'), reason: ApprovalRefusal }),
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export interface ApprovalService {
  /**
   * Takes only an inbound WhatsApp message, so no model output can ever reach it as an approval.
   * Applies `APPROVED` to a post only when the approval guard passes, records the `approval` row
   * tied to the version hash, and otherwise changes nothing. `businessId` is the business the
   * inbound message was routed to.
   */
  handleApprovalReply(businessId: string, message: InboundMessage): Promise<ApprovalDecision>;
}

export const PublishDeferral = z.enum(['global_pause', 'business_pause', 'handoff']);
export type PublishDeferral = z.infer<typeof PublishDeferral>;

export const PublishRefusal = z.enum([
  /** No approval, an invalidated approval, or one whose hash differs from the publication's. */
  'not_approved',
  /** The approval belongs to a version that is no longer the post's current version. */
  'not_current_version',
  /** The publication, its approval, or its post belong to different businesses. */
  'cross_business',
  /** The publication is not `scheduled` or `retry_pending`. */
  'wrong_state',
]);
export type PublishRefusal = z.infer<typeof PublishRefusal>;

export const PublishOutcome = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('published'), providerPostId: z.string().min(1) }),
  /** The provider status check found the post already live; publish was not called again. */
  z.object({ outcome: z.literal('already_published'), providerPostId: z.string().min(1) }),
  z.object({ outcome: z.literal('retry_pending'), error: z.string() }),
  z.object({ outcome: z.literal('failed'), error: z.string() }),
  /** Nothing changed; the job tries again later. */
  z.object({ outcome: z.literal('deferred'), reason: PublishDeferral }),
  /** Nothing changed and nothing reached the provider. */
  z.object({ outcome: z.literal('refused'), reason: PublishRefusal }),
]);
export type PublishOutcome = z.infer<typeof PublishOutcome>;

export interface PublishingJob {
  /** One attempt for one publication, behind the publishing guard. */
  runPublication(publicationId: string): Promise<PublishOutcome>;
}
