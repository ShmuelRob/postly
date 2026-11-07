import { and, eq, inArray, lte } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { asError, log } from '../../shared/logger.js';
import type { Workflow } from './workflow.js';

// The business archive (2026-11-07, the human's "Keep, archive it"; technical-design.md, Cancellation,
// archiving, erasure and the monthly report; state-machines.md, Business). Cancellation never deletes
// data: once `archive_after` passes, a cancelled business applies ARCHIVE, and every row and file stays.

export interface BusinessArchive {
  /** Archives every cancelled business due at `now`; `businessIds` limits it (tests share a database). Returns the archived ids. */
  tick(now: Date, options?: { businessIds?: string[] }): Promise<string[]>;
}

export function createBusinessArchive(deps: { db: Database; workflow: Workflow }): BusinessArchive {
  const { db, workflow } = deps;
  const b = schema.business;
  return {
    async tick(now, options = {}) {
      const due = await db.withSystem('scheduler', (tx) =>
        tx
          .select({ id: b.id })
          .from(b)
          .where(and(eq(b.status, 'cancelled'), lte(b.archiveAfter, now), options.businessIds ? inArray(b.id, options.businessIds) : undefined)),
      );
      const archived: string[] = [];
      for (const { id } of due) {
        try {
          const result = await workflow.apply(id, {
            machine: 'business',
            id,
            event: 'ARCHIVE',
            source: 'system',
            // The scheduler's read may be stale: the guard re-reads the date under the transition's lock.
            guard: async (tx) => {
              const [row] = await tx.select({ archiveAfter: b.archiveAfter }).from(b).where(eq(b.id, id));
              if (!row?.archiveAfter || row.archiveAfter > now) return 'not_due';
              await tx.update(b).set({ archivedAt: now }).where(eq(b.id, id));
              return null;
            },
          });
          if (result.ok) archived.push(id);
        } catch (error) {
          log.error('business archive failed', { businessId: id, error: asError(error) });
        }
      }
      return archived;
    },
  };
}
