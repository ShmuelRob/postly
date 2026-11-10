import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { asError, log } from '../../shared/logger.js';

// Erasure on the owner's explicit request (2026-11-07; technical-design.md, Cancellation, archiving,
// erasure and the monthly report; database-schema.md, erasure_request and Least privilege). The only
// path that deletes a business's data: cancellation archives instead. The deletion role records the
// request and deletes only the business row, and only of a cancelled or archived business; the
// cascade removes the rest, and the workflow_event and erasure_request rows stay.

/** File storage, by path. Every file of a business lives under `<businessId>/`. */
export interface ErasureStorage {
  removePrefix(prefix: string): Promise<void>;
  remove(paths: string[]): Promise<void>;
}

/** Who asked, how and when; the actor is the signed-in team member who runs it. */
export const ErasureRequest = z.object({
  requestedBy: z.enum(['owner', 'representative']),
  channel: z.enum(['whatsapp', 'email', 'phone', 'letter', 'other']),
  requestedAt: z.coerce.date(),
});
export type ErasureRequest = z.infer<typeof ErasureRequest>;

export type ErasureResult = { outcome: 'erased' } | { outcome: 'files_failed' } | { outcome: 'not_found' } | { outcome: 'not_cancelled' };

export interface Erasure {
  erase(businessId: string, request: ErasureRequest & { actor: string }): Promise<ErasureResult>;
}

/** Only a business the cancellation already closed (channels, publications, subscription) is erased. */
const ERASABLE = ['cancelled', 'archived'] as const;

class NothingDeleted extends Error {}

export function createErasure(deps: { db: Database; storage?: ErasureStorage }): Erasure {
  const { db } = deps;
  const b = schema.business;

  return {
    async erase(businessId, request) {
      const [current] = await db.withBusiness('deletion', businessId, (tx) => tx.select({ status: b.status }).from(b).where(eq(b.id, businessId)));
      if (!current) return { outcome: 'not_found' };
      if (!(ERASABLE as readonly string[]).includes(current.status)) return { outcome: 'not_cancelled' };

      let paths: string[];
      try {
        // One transaction: the record and the delete together, or neither.
        paths = await db.withBusiness('deletion', businessId, async (tx) => {
          const media = await tx.select({ path: schema.mediaAsset.storagePath }).from(schema.mediaAsset);
          await tx.insert(schema.erasureRequest).values({
            businessId,
            requestedBy: request.requestedBy,
            channel: request.channel,
            requestedAt: request.requestedAt,
            actor: request.actor,
          });
          const rows = await tx
            .delete(b)
            .where(and(eq(b.id, businessId), inArray(b.status, [...ERASABLE])))
            .returning({ id: b.id });
          if (rows.length !== 1) throw new NothingDeleted();
          return media.map((m) => m.path);
        });
      } catch (error) {
        if (error instanceof NothingDeleted) return { outcome: 'not_cancelled' };
        throw error;
      }
      log.info('business erased on request', { businessId, requestedBy: request.requestedBy, channel: request.channel });

      if (!deps.storage) {
        log.warn('no storage to erase business files from', { businessId });
        return { outcome: 'erased' };
      }
      try {
        await deps.storage.removePrefix(`${businessId}/`);
        const outside = paths.filter((p) => !p.startsWith(`${businessId}/`));
        if (outside.length) await deps.storage.remove(outside);
      } catch (error) {
        // The rows are gone, so nothing can retry this: the team finishes the files by hand.
        log.error('business files not erased', { businessId, error: asError(error) });
        return { outcome: 'files_failed' };
      }
      return { outcome: 'erased' };
    },
  };
}
