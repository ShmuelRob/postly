import { and, eq, inArray, lte } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { asError, log } from '../../shared/logger.js';

// Data deletion after cancellation (WP-43; technical-design.md, Cancellation, data deletion and the
// monthly report; database-schema.md, Least privilege). The deletion role deletes only the business
// row, and only of a cancelled business past `data_delete_after`; the cascade removes the rest.

/** File storage, by path. Every file of a business lives under `<businessId>/`. */
export interface DeletionStorage {
  removePrefix(prefix: string): Promise<void>;
  remove(paths: string[]): Promise<void>;
}

export interface DataDeletion {
  /** Deletes every business due at `now`; `businessIds` limits it (tests share a database). Returns the deleted ids. */
  tick(now: Date, options?: { businessIds?: string[] }): Promise<string[]>;
}


export function createDataDeletion(deps: { db: Database; storage?: DeletionStorage }): DataDeletion {
  const { db } = deps;
  const b = schema.business;

  /** One business: its media paths, then the delete with the due condition in the delete itself. */
  async function deleteBusiness(businessId: string, now: Date): Promise<boolean> {
    const { deleted, paths } = await db.withBusiness('deletion', businessId, async (tx) => {
      const media = await tx.select({ path: schema.mediaAsset.storagePath }).from(schema.mediaAsset);
      const rows = await tx
        .delete(b)
        .where(and(eq(b.id, businessId), eq(b.status, 'cancelled'), lte(b.dataDeleteAfter, now)))
        .returning({ id: b.id });
      return { deleted: rows.length === 1, paths: media.map((m) => m.path) };
    });
    if (!deleted) return false;
    if (!deps.storage) {
      log.warn('no storage to delete business files from', { businessId });
      return true;
    }
    try {
      await deps.storage.removePrefix(`${businessId}/`);
      const outside = paths.filter((p) => !p.startsWith(`${businessId}/`));
      if (outside.length) await deps.storage.remove(outside);
    } catch (error) {
      // The rows are gone, so a later run cannot find these files; the media retention policy covers orphans.
      log.error('business files not deleted', { businessId, error: asError(error) });
    }
    return true;
  }

  return {
    async tick(now, options = {}) {
      const due = await db.withSystem('scheduler', (tx) =>
        tx
          .select({ id: b.id })
          .from(b)
          .where(and(eq(b.status, 'cancelled'), lte(b.dataDeleteAfter, now), options.businessIds ? inArray(b.id, options.businessIds) : undefined)),
      );
      const deleted: string[] = [];
      for (const { id } of due) {
        try {
          if (await deleteBusiness(id, now)) deleted.push(id);
        } catch (error) {
          log.error('data deletion failed', { businessId: id, error: asError(error) });
        }
      }
      return deleted;
    },
  };
}
