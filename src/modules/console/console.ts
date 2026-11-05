import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Database, Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import type { EventResult, Workflow } from '../workflow/index.js';

// The team console (technical-design.md, "Console (Phase 1)"): reads and writes only through
// withSystem('console') and the workflow module's public API.

/** A refused console action: 404 when the row is missing, 409 when its state does not allow it. */
export class ConsoleActionError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly reason: string,
    readonly detail?: string,
  ) {
    super(detail ?? reason);
  }
}

export interface BusinessSummary {
  id: string;
  name: string;
  status: string;
  step: string | null;
  handoffAt: Date | null;
}

export interface Draft {
  id: string;
  businessId: string;
  status: string;
  format: string;
  updatedAt: Date;
  version: { versionNumber: number; captions: unknown; contentHash: string; factCheckPassed: boolean } | null;
  publications: Array<{ id: string; network: string; status: string; lastError: string | null }>;
}

export interface ConsoleService {
  businesses(): Promise<BusinessSummary[]>;
  messages(businessId: string): Promise<Array<typeof schema.message.$inferSelect>>;
  /** The business's agent turns, newest first, with their steps: what the agent asked for and what code answered (WP-90). */
  agentTurns(businessId: string): Promise<Array<typeof schema.agentTurn.$inferSelect>>;
  drafts(businessId?: string): Promise<Draft[]>;
  openItems(): Promise<Array<typeof schema.consoleItem.$inferSelect>>;
  system(): Promise<{ publishingPaused: boolean; pausedReason: string | null; pausedAt: Date | null; pausedBy: string | null }>;
  resolveItem(id: string): Promise<void>;
  /** Hands the item's business to a person and resolves the item. */
  routeItem(id: string, actor?: string): Promise<void>;
  startHandoff(businessId: string, actor?: string): Promise<void>;
  clearHandoff(businessId: string): Promise<void>;
  /** A failed publication goes back to retry_pending; the publishing job still checks the approved hash. */
  retryPublication(id: string, actor?: string): Promise<void>;
  pauseBusiness(businessId: string, actor?: string): Promise<void>;
  resumeBusiness(businessId: string, actor?: string): Promise<void>;
  setGlobalPause(paused: boolean, by: string, reason?: string): Promise<void>;
  /** The plan's current monthly price (its newest `plan_price` row, or null) and every change, newest first. */
  price(plan?: string): Promise<{ current: PlanPriceRow | null; history: PlanPriceRow[] }>;
  /** Changes the monthly price by adding a `plan_price` row; links sent afterwards charge it (T1). */
  setPrice(input: { plan?: string; amountAgorot: number; by: string; reason?: string }): Promise<PlanPriceRow>;
}

export type PlanPriceRow = typeof schema.planPrice.$inferSelect;

/** PRD, Payment: the single plan for now (billing's DEFAULT_PLAN). */
const DEFAULT_PLAN = 'basic';

const refused = (result: EventResult): void => {
  if (!result.ok) throw new ConsoleActionError(result.reason === 'not_found' ? 404 : 409, result.reason, result.detail ?? result.from);
};

/** The workflow audit trail's actor for a console action (WP-46): `team:<signed-in email>`. */
const auditActor = (actor: string | undefined) => (actor ? { actor: `team:${actor}` } : {});

export function createConsole(db: Database, workflow: Workflow): ConsoleService {
  const sys = <T>(fn: (tx: Tx) => Promise<T>) => db.withSystem('console', fn);

  const item = async (id: string) => {
    const [row] = await sys((tx) => tx.select().from(schema.consoleItem).where(eq(schema.consoleItem.id, id)));
    if (!row) throw new ConsoleActionError(404, 'not_found');
    return row;
  };
  const resolve = (where: ReturnType<typeof eq>) =>
    sys((tx) =>
      tx
        .update(schema.consoleItem)
        .set({ status: 'resolved', resolvedAt: new Date(), updatedAt: new Date() })
        .where(and(where, eq(schema.consoleItem.status, 'open'))),
    );
  const businessExists = async (businessId: string) => {
    const [row] = await sys((tx) => tx.select({ id: schema.business.id }).from(schema.business).where(eq(schema.business.id, businessId)));
    if (!row) throw new ConsoleActionError(404, 'not_found');
  };

  return {
    businesses: () =>
      sys((tx) =>
        tx
          .select({
            id: schema.business.id,
            name: schema.business.name,
            status: schema.business.status,
            step: schema.conversationState.step,
            handoffAt: schema.conversationState.handoffAt,
          })
          .from(schema.business)
          .leftJoin(schema.conversationState, eq(schema.conversationState.businessId, schema.business.id))
          .orderBy(desc(schema.business.createdAt)),
      ),

    messages: (businessId) =>
      sys((tx) => tx.select().from(schema.message).where(eq(schema.message.businessId, businessId)).orderBy(asc(schema.message.createdAt))),

    agentTurns: (businessId) =>
      sys((tx) => tx.select().from(schema.agentTurn).where(eq(schema.agentTurn.businessId, businessId)).orderBy(desc(schema.agentTurn.startedAt)).limit(50)),

    async drafts(businessId) {
      return sys(async (tx) => {
        const posts = await tx
          .select()
          .from(schema.post)
          .where(businessId ? eq(schema.post.businessId, businessId) : undefined)
          .orderBy(desc(schema.post.updatedAt))
          .limit(200);
        if (posts.length === 0) return [];
        const ids = posts.map((p) => p.id);
        const versions = await tx.select().from(schema.postVersion).where(inArray(schema.postVersion.postId, ids));
        const pubs = await tx.select().from(schema.publication).where(inArray(schema.publication.postId, ids));
        return posts.map((p): Draft => {
          const v = versions.find((x) => x.id === p.currentVersionId) ?? versions.filter((x) => x.postId === p.id).sort((a, b) => b.versionNumber - a.versionNumber)[0];
          return {
            id: p.id,
            businessId: p.businessId,
            status: p.status,
            format: p.format,
            updatedAt: p.updatedAt,
            version: v ? { versionNumber: v.versionNumber, captions: v.captions, contentHash: v.contentHash, factCheckPassed: v.factCheckPassed } : null,
            publications: pubs.filter((x) => x.postId === p.id).map((x) => ({ id: x.id, network: x.network, status: x.status, lastError: x.lastError })),
          };
        });
      });
    },

    openItems: () =>
      sys((tx) => tx.select().from(schema.consoleItem).where(eq(schema.consoleItem.status, 'open')).orderBy(desc(schema.consoleItem.createdAt)).limit(500)),

    async system() {
      const [row] = await sys((tx) => tx.select().from(schema.systemControl).where(eq(schema.systemControl.id, 1)));
      return {
        publishingPaused: row?.publishingPaused ?? false,
        pausedReason: row?.pausedReason ?? null,
        pausedAt: row?.pausedAt ?? null,
        pausedBy: row?.pausedBy ?? null,
      };
    },

    async resolveItem(id) {
      await item(id);
      await resolve(eq(schema.consoleItem.id, id));
    },

    async routeItem(id, actor) {
      const row = await item(id);
      if (row.status !== 'open') throw new ConsoleActionError(409, 'resolved');
      if (!row.businessId) throw new ConsoleActionError(409, 'no_business', 'an item without a business can only be resolved');
      await workflow.startHandoff(row.businessId, { routedFrom: row.id, kind: row.kind, ...(actor ? { by: actor } : {}) });
      await resolve(eq(schema.consoleItem.id, id));
    },

    async startHandoff(businessId, actor) {
      await businessExists(businessId);
      await workflow.startHandoff(businessId, { source: 'console', ...(actor ? { by: actor } : {}) });
    },

    async clearHandoff(businessId) {
      await businessExists(businessId);
      await workflow.clearHandoff(businessId);
    },

    async retryPublication(id, actor) {
      const [pub] = await sys((tx) => tx.select().from(schema.publication).where(eq(schema.publication.id, id)));
      if (!pub) throw new ConsoleActionError(404, 'not_found');
      refused(await workflow.apply(pub.businessId, { machine: 'publication', id, event: 'RETRY_REQUESTED', source: 'console', ...auditActor(actor) }));
      const [post] = await sys((tx) => tx.select({ status: schema.post.status }).from(schema.post).where(eq(schema.post.id, pub.postId)));
      if (post?.status === 'failed') {
        refused(await workflow.apply(pub.businessId, { machine: 'post', id: pub.postId, event: 'PUBLISHING_STARTED', source: 'console', ...auditActor(actor) }));
      }
      await resolve(and(eq(schema.consoleItem.kind, 'publication_failed'), eq(schema.consoleItem.referenceId, id))!);
    },

    async pauseBusiness(businessId, actor) {
      refused(await workflow.apply(businessId, { machine: 'business', id: businessId, event: 'PAUSE', source: 'console', ...auditActor(actor) }));
    },

    async resumeBusiness(businessId, actor) {
      refused(
        await workflow.apply(businessId, {
          machine: 'business',
          id: businessId,
          event: 'RESUME',
          source: 'console',
          ...auditActor(actor),
          // state-machines.md: at least one channel connection is verified.
          guard: async (tx) => {
            const c = schema.channelConnection;
            const [row] = await tx.select({ id: c.id }).from(c).where(and(eq(c.businessId, businessId), eq(c.status, 'verified'))).limit(1);
            return row ? null : 'no verified channel connection';
          },
        }),
      );
    },

    setGlobalPause: (paused, by, reason) => workflow.setGlobalPause(paused, by, reason),

    async price(plan = DEFAULT_PLAN) {
      const history = await sys((tx) =>
        tx.select().from(schema.planPrice).where(eq(schema.planPrice.plan, plan)).orderBy(desc(schema.planPrice.id)).limit(200),
      );
      return { current: history[0] ?? null, history };
    },

    async setPrice({ plan = DEFAULT_PLAN, amountAgorot, by, reason }) {
      const [row] = await sys((tx) =>
        tx.insert(schema.planPrice).values({ plan, amountAgorot, currency: 'ILS', changedBy: by, reason: reason ?? null }).returning(),
      );
      return row!;
    },
  };
}
