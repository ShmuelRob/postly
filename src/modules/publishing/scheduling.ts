import { and, eq, inArray, isNull } from 'drizzle-orm';
import { NETWORKS, type Network } from '../../contracts/common.js';
import type { Database, Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';

// Publications (state-machines.md, Post and Publication; technical-design.md, Approval flow).
// Scheduling creates the publications from the post's valid approval, at the confirmed times (WP-34:
// times.ts proposes them, job.ts publishes).

/** The workflow's `apply`, for the post's `SCHEDULED` (publishing does not import workflow). */
export type ApplyPostEvent = (
  businessId: string,
  request: {
    machine: 'post';
    id: string;
    event: 'SCHEDULED';
    source: 'system';
    role: 'publishing';
    guard: (tx: Tx, current: { from: string; to: string }) => Promise<string | null>;
  },
) => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;

/** Scheduling refused because a network of the approved version has no verified connection. */
export class MissingChannelError extends Error {
  override name = 'MissingChannelError';
  constructor(readonly networks: Network[]) {
    super(`no verified connection for ${networks.join(', ')}`);
  }
}

const MISSING = 'no verified connection for ';

export interface Scheduling {
  /**
   * The owner confirmed the time: one `scheduled` publication per network of the approved version
   * (its caption keys), each on that network's `verified` connection, tied to the valid approval of
   * the post's current version, and `SCHEDULED` on the post, in one transaction. Throws, scheduling
   * nothing, when the post is not `approved`, has no valid approval of its current version, or a
   * network of the approved version has no verified connection.
   */
  schedule(businessId: string, postId: string, scheduledFor: Date): Promise<{ publicationId: string; network: Network }[]>;
  /** Cancels the post's `scheduled` and `retry_pending` publications. */
  cancelPending(businessId: string, postId: string): Promise<void>;
  /** Cancellation (WP-43): cancels every `scheduled` and `retry_pending` publication of the business. */
  cancelAllPending(businessId: string): Promise<void>;
}

export function createScheduling(deps: { db: Database; apply: ApplyPostEvent; now?: () => Date }): Scheduling {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async schedule(businessId, postId, scheduledFor) {
      let rows: { publicationId: string; network: Network }[] = [];
      const result = await deps.apply(businessId, {
        machine: 'post',
        id: postId,
        event: 'SCHEDULED',
        source: 'system',
        role: 'publishing',
        guard: async (tx) => {
          const [post] = await tx.select({ currentVersionId: schema.post.currentVersionId }).from(schema.post).where(eq(schema.post.id, postId));
          if (!post?.currentVersionId) return 'the post has no current version';
          const a = schema.approval;
          const [approval] = await tx
            .select()
            .from(a)
            .where(and(eq(a.postId, postId), isNull(a.invalidatedAt), eq(a.postVersionId, post.currentVersionId)));
          if (!approval) return 'no valid approval of the current version';
          const [version] = await tx
            .select({ captions: schema.postVersion.captions })
            .from(schema.postVersion)
            .where(eq(schema.postVersion.id, approval.postVersionId));
          const networks = NETWORKS.filter((n) => (version?.captions as Partial<Record<Network, unknown>> | undefined)?.[n]);
          if (networks.length === 0) return 'the approved version has no network';
          const channels = await tx
            .select()
            .from(schema.channelConnection)
            .where(and(eq(schema.channelConnection.status, 'verified'), inArray(schema.channelConnection.network, networks)));
          const missing = networks.filter((n) => !channels.some((c) => c.network === n));
          if (missing.length > 0) return `${MISSING}${missing.join(', ')}`;
          rows = await tx
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
          return null;
        },
      });
      if (!result.ok && result.detail?.startsWith(MISSING)) throw new MissingChannelError(result.detail.slice(MISSING.length).split(', ') as Network[]);
      if (!result.ok) throw new Error(`post ${postId} was not scheduled: ${result.detail ?? result.reason}`);
      return rows;
    },

    async cancelPending(businessId, postId) {
      await db.withBusiness('publishing', businessId, (tx) =>
        tx
          .update(schema.publication)
          .set({ status: 'cancelled', updatedAt: now() })
          .where(and(eq(schema.publication.postId, postId), inArray(schema.publication.status, ['scheduled', 'retry_pending']))),
      );
    },

    async cancelAllPending(businessId) {
      await db.withBusiness('publishing', businessId, (tx) =>
        tx
          .update(schema.publication)
          .set({ status: 'cancelled', updatedAt: now() })
          .where(and(eq(schema.publication.businessId, businessId), inArray(schema.publication.status, ['scheduled', 'retry_pending']))),
      );
    },
  };
}
