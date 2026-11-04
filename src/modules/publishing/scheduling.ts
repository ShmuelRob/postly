import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Network } from '../../contracts/common.js';
import { postMachine } from '../../contracts/state-machines/index.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';

// Publications (state-machines.md, Post and Publication; technical-design.md, Approval flow).
// Interim until WP-34: scheduling creates the publications from the post's valid approval; WP-34
// adds the time proposals and the publishing job.

export interface Scheduling {
  /**
   * The owner confirmed the time: one `scheduled` publication per `verified` channel, tied to the
   * valid approval of the post's current version, and `SCHEDULED` on the post, in one transaction.
   * Throws when the post is not `approved` or has no valid approval of its current version.
   */
  schedule(businessId: string, postId: string, scheduledFor: Date): Promise<{ publicationId: string; network: Network }[]>;
  /** Cancels the post's `scheduled` and `retry_pending` publications. */
  cancelPending(businessId: string, postId: string): Promise<void>;
}

export function createScheduling(deps: { db: Database; now?: () => Date }): Scheduling {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const scheduledTo = (postMachine.transitions as Record<string, Record<string, string> | undefined>).approved?.SCHEDULED;

  return {
    async schedule(businessId, postId, scheduledFor) {
      return db.withBusiness('publishing', businessId, async (tx) => {
        const [post] = await tx.select().from(schema.post).where(eq(schema.post.id, postId)).for('update');
        if (!post || post.status !== 'approved' || scheduledTo !== 'scheduled') throw new Error(`post ${postId} is not approved`);
        const a = schema.approval;
        const [approval] = await tx
          .select()
          .from(a)
          .where(and(eq(a.postId, postId), isNull(a.invalidatedAt), eq(a.postVersionId, post.currentVersionId ?? postId)));
        if (!approval) throw new Error(`post ${postId} has no valid approval of its current version`);
        const channels = await tx
          .select()
          .from(schema.channelConnection)
          .where(eq(schema.channelConnection.status, 'verified'));
        if (channels.length === 0) throw new Error(`business ${businessId} has no verified channel`);
        const rows = await tx
          .insert(schema.publication)
          .values(
            channels.map((c) => ({
              businessId,
              postId,
              approvalId: approval.id,
              approvedVersionHash: approval.approvedVersionHash,
              channelConnectionId: c.id,
              network: c.network,
              scheduledFor,
            })),
          )
          .returning({ publicationId: schema.publication.id, network: schema.publication.network });
        await tx.update(schema.post).set({ status: 'scheduled', updatedAt: now() }).where(eq(schema.post.id, postId));
        return rows;
      });
    },

    async cancelPending(businessId, postId) {
      await db.withBusiness('publishing', businessId, (tx) =>
        tx
          .update(schema.publication)
          .set({ status: 'cancelled', updatedAt: now() })
          .where(and(eq(schema.publication.postId, postId), inArray(schema.publication.status, ['scheduled', 'retry_pending']))),
      );
    },
  };
}
