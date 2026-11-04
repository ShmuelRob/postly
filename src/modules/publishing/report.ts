import { and, eq, gte, isNotNull, lt } from 'drizzle-orm';
import type { PublishingProvider } from '../../contracts/providers/publishing.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';

// The monthly report (WP-43; technical-design.md, Cancellation, data deletion and the monthly report).
// Only the metrics of Postly's own publications that went live in the month count.

export interface MonthlyFigures {
  /** Posts with at least one publication live in the month. */
  posts: number;
  /** Sum of reach over the publications the provider gave it for; undefined when it gave none. */
  reach?: number;
  /** Likes plus comments plus shares; undefined when the provider gave none of them. */
  engagement?: number;
}

export interface MonthlyReport {
  /**
   * The figures for publications with `published_at` in `[from, to)`, or null when nothing was
   * published or the provider supplied no metric (then nothing is sent).
   */
  figures(businessId: string, from: Date, to: Date): Promise<MonthlyFigures | null>;
}

/** The previous calendar month in UTC, for a run at `now`. */
export function previousMonth(now: Date): { from: Date; to: Date } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 1, 1));
  return { from, to };
}

export function createMonthlyReport(deps: { db: Database; provider: PublishingProvider }): MonthlyReport {
  const { db, provider } = deps;
  const p = schema.publication;
  const add = (sum: number | undefined, value: number | undefined) => (value === undefined ? sum : (sum ?? 0) + value);

  return {
    async figures(businessId, from, to) {
      const rows = await db.withBusiness('publishing', businessId, (tx) =>
        tx
          .select({ postId: p.postId, providerPostId: p.providerPostId, accountId: schema.channelConnection.providerAccountId })
          .from(p)
          .innerJoin(schema.channelConnection, eq(schema.channelConnection.id, p.channelConnectionId))
          .where(and(eq(p.businessId, businessId), eq(p.status, 'published'), isNotNull(p.providerPostId), gte(p.publishedAt, from), lt(p.publishedAt, to))),
      );
      if (rows.length === 0) return null;
      const ours = new Set(rows.map((r) => r.providerPostId!));
      const accounts = [...new Set(rows.map((r) => r.accountId).filter((a): a is string => !!a))];
      let reach: number | undefined;
      let engagement: number | undefined;
      for (const providerAccountId of accounts) {
        // The provider's window is inclusive, so it ends just before the next month.
        const metrics = await provider.getMetrics({ providerAccountId, from: from.toISOString(), to: new Date(to.getTime() - 1).toISOString() });
        for (const m of metrics) {
          if (!ours.has(m.providerPostId)) continue;
          reach = add(reach, m.reach);
          for (const v of [m.likes, m.comments, m.shares]) engagement = add(engagement, v);
        }
      }
      if (reach === undefined && engagement === undefined) return null;
      return {
        posts: new Set(rows.map((r) => r.postId)).size,
        ...(reach === undefined ? {} : { reach }),
        ...(engagement === undefined ? {} : { engagement }),
      };
    },
  };
}
