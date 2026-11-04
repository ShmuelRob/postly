import { eq, inArray } from 'drizzle-orm';
import { BusinessProfile } from '../../contracts/business-profile.js';
import type { Network } from '../../contracts/common.js';
import type { SendTemplateRequest } from '../../contracts/providers/messaging.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import * as copy from './cancellation-copy.js';
import type { Workflow } from './workflow.js';

// Cancellation (WP-43; technical-design.md, Cancellation, data deletion and the monthly report;
// state-machines.md, Business). Each step is idempotent, so running it again finishes a cancellation
// that stopped half way. The other modules' steps come in as functions (workflow imports none of them).

/** Provisional (PRD open question): 30 days from cancellation to deletion. */
export const RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Posts the post machine can still cancel (state-machines.md, Post). */
const CANCELLABLE = ['planned', 'drafting', 'awaiting_clarification', 'awaiting_approval', 'approved', 'scheduled', 'needs_review'] as const;

export interface CancellationDeps {
  db: Database;
  workflow: Workflow;
  /** Publishing: disconnects every channel at the provider and applies `REVOKED`. */
  revokeChannels(businessId: string): Promise<{ revoked: Network[]; providerFailed: Network[] }>;
  /** Publishing: cancels every `scheduled` and `retry_pending` publication. */
  cancelPublications(businessId: string): Promise<void>;
  /** Billing: cancels the subscription at the payment provider; absent when no payment provider is wired. */
  cancelSubscription?(businessId: string): Promise<void>;
  messaging: { sendTemplate(businessId: string, request: SendTemplateRequest): Promise<unknown> };
  retentionMs?: number;
  now?: () => Date;
}

export type CancellationResult =
  | { outcome: 'cancelled'; deleteAfter: Date; revoked: Network[]; providerFailed: Network[] }
  | { outcome: 'not_found' };

export interface Cancellation {
  /** Cancels the business (from the console or the payment provider's `cancelled`). */
  cancel(businessId: string, reason: 'console' | 'payment_provider'): Promise<CancellationResult>;
}

export function createCancellation(deps: CancellationDeps): Cancellation {
  const { db, workflow } = deps;
  const now = deps.now ?? (() => new Date());
  const retentionMs = deps.retentionMs ?? RETENTION_MS;
  const b = schema.business;

  const load = (businessId: string) => db.withBusiness('workflow', businessId, async (tx) => (await tx.select().from(b).where(eq(b.id, businessId)))[0]);

  return {
    async cancel(businessId, reason) {
      const before = await load(businessId);
      if (!before) return { outcome: 'not_found' };

      // 1. CANCEL sets the dates; a business already cancelled keeps its own.
      if (before.status !== 'cancelled') {
        const at = now();
        const result = await workflow.apply(businessId, {
          machine: 'business',
          id: businessId,
          event: 'CANCEL',
          source: reason === 'console' ? 'console' : 'system',
          guard: async (tx) => {
            await tx.update(b).set({ cancelledAt: at, dataDeleteAfter: new Date(at.getTime() + retentionMs) }).where(eq(b.id, businessId));
            return null;
          },
        });
        if (!result.ok && (await load(businessId))?.status !== 'cancelled') throw new Error(`business ${businessId}: CANCEL refused (${result.reason})`);
      }
      const business = (await load(businessId))!;

      // 2. Channels, at once.
      const channels = await deps.revokeChannels(businessId);

      // 3. Pending publications and open posts.
      await deps.cancelPublications(businessId);
      const open = await db.withBusiness('workflow', businessId, (tx) => tx.select({ id: schema.post.id }).from(schema.post).where(inArray(schema.post.status, [...CANCELLABLE])));
      for (const post of open) await workflow.apply(businessId, { machine: 'post', id: post.id, event: 'CANCELLED', source: 'system' });

      // 4. The subscription.
      await deps.cancelSubscription?.(businessId);

      // 5. The owner, by template (the window may be closed); only on the first cancellation.
      const deleteAfter = business.dataDeleteAfter!;
      if (before.status !== 'cancelled') {
        const profile = BusinessProfile.safeParse(business.profile);
        await deps.messaging.sendTemplate(businessId, {
          to: business.approverPhone,
          language: profile.success ? profile.data.languages[0]! : 'he',
          templateName: copy.CANCELLED_TEMPLATE,
          variables: { deleteAfter: copy.deletionDate(deleteAfter, business.timezone) },
        });
      }
      return { outcome: 'cancelled', deleteAfter, ...channels };
    },
  };
}
