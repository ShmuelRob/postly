import { and, asc, desc, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { Database, Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import type { EventResult, Workflow } from '../workflow/index.js';
import { parseRange, readInsights } from './insights.js';
import { AGENT_NAMES } from '../../contracts/agent.js';
import { BusinessProfile, BusinessProfileDraft } from '../../contracts/business-profile.js';
import { MODEL_TASK_NAMES } from '../../contracts/model-tasks.js';
import type {
  AgentConfigPatch,
  AgentConfigRow,
  BusinessDetail,
  BusinessRow,
  ConsoleActionRow,
  FailureRow,
  ModelRunRow,
  ModelRunSummary,
  ModelTaskPatch,
  ModelTaskRow,
  Insights,
  InsightsRange,
  Overview,
  PostDetail,
  SystemSettings,
  WriteMeta,
} from './views.js';

// The team console (technical-design.md, "Console (Phase 1)"): reads and writes only through
// withSystem('console') and the workflow module's public API.

/** A refused console action: 404 when the row is missing, 409 when its state does not allow it, 500 when it ran only in part (an erasure whose files failed). */
export class ConsoleActionError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500,
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

  // The redesigned console's read models (views.ts; technical-design.md, "Console (Phase 1)").
  /** The Insights tab for a range of UTC days (views.ts, Insights); 400 `invalid_range` when `to` is before `from` or it spans over 366 days. */
  insights(range: InsightsRange, now?: Date): Promise<Insights>;
  /** The Overview tab. `now` defaults to the current time. */
  overview(now?: Date): Promise<Overview>;
  /** Every business with its conversation state, open item count and newest message, newest business first. */
  businessRows(): Promise<BusinessRow[]>;
  /** One business for the client panel and the profile editor; 404 ConsoleActionError when missing. */
  business(businessId: string): Promise<BusinessDetail>;
  /** The business's posts, newest first (at most 50), each with every version, its approvals, and its publications. */
  posts(businessId: string): Promise<PostDetail[]>;
  /** Model runs without input and output, newest first: one business's, or every business's when omitted (at most `limit`, default 100). */
  modelRuns(businessId?: string, limit?: number): Promise<ModelRunSummary[]>;
  /** One whole model run; 404 when missing. */
  modelRun(id: string): Promise<ModelRunRow>;
  /** The storage path and type of a media asset, for GET /console/media/:assetId; 404 when missing. */
  mediaAsset(id: string): Promise<{ storagePath: string; mimeType: string }>;
  /** The global settings: the publishing pause and the agent daily cost cap. */
  settings(): Promise<SystemSettings>;
  modelTasks(): Promise<ModelTaskRow[]>;
  agentConfigs(): Promise<AgentConfigRow[]>;
  /** The newest console_action rows (default 200), optionally of one business. */
  actions(businessId?: string, limit?: number): Promise<ConsoleActionRow[]>;

  // Writes. Each adds a console_action row (before and after) in the same transaction.
  /**
   * Replaces the profile: BusinessProfile once the business is past onboarding, BusinessProfileDraft
   * while it onboards (400 `invalid_profile` with the issues in detail). 409 `approver_locked` when
   * approverPhone differs from the stored one. business.name follows profile.name.
   */
  setProfile(businessId: string, profile: unknown, meta: WriteMeta): Promise<void>;
  /** system_control.agent_daily_cost_cap_usd; must be greater than 0 (400 otherwise). */
  setAgentCostCap(usd: number, meta: WriteMeta): Promise<void>;
  /** 404 for an unknown agent; 400 for a non-positive limit or min_confidence outside 0..1. */
  setAgentConfig(agent: string, patch: AgentConfigPatch, meta: WriteMeta): Promise<AgentConfigRow>;
  /** 404 for an unknown task; 400 `unknown_prompt_version` when activePromptVersion has no prompt_template row. */
  setModelTask(task: string, patch: ModelTaskPatch, meta: WriteMeta): Promise<ModelTaskRow>;
}

export type PlanPriceRow = typeof schema.planPrice.$inferSelect;

/** PRD, Payment: the single plan for now (billing's DEFAULT_PLAN). */
const DEFAULT_PLAN = 'basic';

const refused = (result: EventResult): void => {
  if (!result.ok) throw new ConsoleActionError(result.reason === 'not_found' ? 404 : 409, result.reason, result.detail ?? result.from);
};

/** The workflow audit trail's actor for a console action (WP-46): `team:<signed-in email>`. */
const auditActor = (actor: string | undefined) => (actor ? { actor: `team:${actor}` } : {});

/** A numeric column (a string from Postgres) as a number of dollars; null counts as 0. */
const usd = (value: string | number | null | undefined): number => (value === null || value === undefined ? 0 : Number(value));

const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD of a UTC day. */
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** The fields whose JSON differs between two objects, each side holding only those fields. */
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null),
  );
  return {
    before: Object.fromEntries(keys.map((k) => [k, before[k] ?? null])),
    after: Object.fromEntries(keys.map((k) => [k, after[k] ?? null])),
  };
}

const invalid = (field: string, rule: string) => new ConsoleActionError(400, 'invalid_value', `${field}: ${rule}`);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const AGENT_INTEGER_LIMITS = ['maxSteps', 'maxToolCalls', 'timeoutMs', 'maxRefusals', 'maxRepeatedQuestions'] as const;
const AGENT_COST_LIMITS = ['maxTurnCostUsd', 'maxBusinessDailyCostUsd'] as const;

function agentConfigRow(r: typeof schema.agentConfig.$inferSelect): AgentConfigRow {
  return {
    agent: r.agent,
    maxSteps: r.maxSteps,
    maxToolCalls: r.maxToolCalls,
    maxTurnCostUsd: usd(r.maxTurnCostUsd),
    maxBusinessDailyCostUsd: usd(r.maxBusinessDailyCostUsd),
    timeoutMs: r.timeoutMs,
    minConfidence: r.minConfidence,
    maxRefusals: r.maxRefusals,
    maxRepeatedQuestions: r.maxRepeatedQuestions,
    updatedAt: r.updatedAt,
  };
}

function modelTaskRow(r: typeof schema.modelTaskConfig.$inferSelect, promptVersions: number[]): ModelTaskRow {
  return {
    task: r.task,
    provider: r.provider,
    model: r.model,
    fallbackProvider: r.fallbackProvider,
    fallbackModel: r.fallbackModel,
    temperature: r.temperature,
    maxCostUsd: usd(r.maxCostUsd),
    maxRetries: r.maxRetries,
    activePromptVersion: r.activePromptVersion,
    promptVersions,
    updatedAt: r.updatedAt,
  };
}

const modelRunSummary = {
  id: schema.modelRun.id,
  businessId: schema.modelRun.businessId,
  task: schema.modelRun.task,
  promptVersion: schema.modelRun.promptVersion,
  provider: schema.modelRun.provider,
  model: schema.modelRun.model,
  attempt: schema.modelRun.attempt,
  valid: schema.modelRun.valid,
  error: schema.modelRun.error,
  inputTokens: schema.modelRun.inputTokens,
  outputTokens: schema.modelRun.outputTokens,
  costUsd: schema.modelRun.costUsd,
  durationMs: schema.modelRun.durationMs,
  agentTurnId: schema.modelRun.agentTurnId,
  createdAt: schema.modelRun.createdAt,
};

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

  /** The console_action row of a write, in the write's transaction. */
  const record = (
    tx: Tx,
    row: { businessId: string | null; action: (typeof schema.CONSOLE_ACTIONS)[number]; target: string; before: unknown; after: unknown },
    meta: WriteMeta,
  ) => tx.insert(schema.consoleAction).values({ ...row, actor: meta.actor, reason: meta.reason ?? null });

  const businessRowsOf = async (tx: Tx, businessId?: string): Promise<BusinessRow[]> => {
    const b = schema.business;
    const cs = schema.conversationState;
    const rows = await tx
      .select({
        id: b.id,
        name: b.name,
        status: b.status,
        step: cs.step,
        handoffAt: cs.handoffAt,
        openQuestion: cs.openQuestion,
        lastInboundAt: cs.lastInboundAt,
        createdAt: b.createdAt,
      })
      .from(b)
      .leftJoin(cs, eq(cs.businessId, b.id))
      .where(businessId ? eq(b.id, businessId) : undefined)
      .orderBy(desc(b.createdAt));
    if (rows.length === 0) return [];
    const ci = schema.consoleItem;
    const items = await tx
      .select({ businessId: ci.businessId, n: sql<number>`count(*)::int` })
      .from(ci)
      .where(and(eq(ci.status, 'open'), isNotNull(ci.businessId), businessId ? eq(ci.businessId, businessId) : undefined))
      .groupBy(ci.businessId);
    const m = schema.message;
    const last = await tx
      .selectDistinctOn([m.businessId], { businessId: m.businessId, body: m.body, kind: m.kind, direction: m.direction, createdAt: m.createdAt })
      .from(m)
      .where(businessId ? eq(m.businessId, businessId) : isNotNull(m.businessId))
      .orderBy(m.businessId, desc(m.createdAt), desc(m.seq));
    const p = schema.publication;
    const published = await tx
      .select({ businessId: p.businessId, n: sql<number>`count(*)::int` })
      .from(p)
      .where(and(eq(p.status, 'published'), businessId ? eq(p.businessId, businessId) : undefined))
      .groupBy(p.businessId);
    const r = schema.modelRun;
    const spend = await tx
      .select({ businessId: r.businessId, usd: sql<string | null>`sum(${r.costUsd})` })
      .from(r)
      .where(businessId ? eq(r.businessId, businessId) : isNotNull(r.businessId))
      .groupBy(r.businessId);
    const publishedOf = new Map(published.map((x) => [x.businessId, x.n]));
    const spendOf = new Map(spend.map((x) => [x.businessId, Number(x.usd ?? 0)]));
    const itemsOf = new Map(items.map((r) => [r.businessId, Number(r.n)]));
    const lastOf = new Map(last.map(({ businessId: id, ...rest }) => [id, rest]));
    return rows.map((r) => {
      const q = r.openQuestion as { key?: unknown } | null;
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        step: r.step,
        handoffAt: r.handoffAt,
        openQuestion: q && typeof q.key === 'string' ? q.key : null,
        lastInboundAt: r.lastInboundAt,
        openItems: itemsOf.get(r.id) ?? 0,
        published: publishedOf.get(r.id) ?? 0,
        spendUsd: spendOf.get(r.id) ?? 0,
        lastMessage: lastOf.get(r.id) ?? null,
        createdAt: r.createdAt,
      };
    });
  };

  const promptVersionsOf = async (tx: Tx, task?: (typeof MODEL_TASK_NAMES)[number]) => {
    const p = schema.promptTemplate;
    const rows = await tx.select({ task: p.task, version: p.version }).from(p).where(task ? eq(p.task, task) : undefined).orderBy(asc(p.task), asc(p.version));
    const byTask = new Map<string, number[]>();
    for (const r of rows) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r.version]);
    return byTask;
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

    async insights(range, now = new Date()) {
      const bounds = parseRange(range);
      if (!bounds) throw new ConsoleActionError(400, 'invalid_range', 'from and to are UTC days (YYYY-MM-DD), to not before from, at most 366 days');
      return sys((tx) => readInsights(tx, range, bounds, now));
    },

    async overview(now = new Date()) {
      const since24h = new Date(now.getTime() - DAY_MS).toISOString();
      const since7d = new Date(now.getTime() - 7 * DAY_MS).toISOString();
      const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const firstDay = new Date(today.getTime() - 13 * DAY_MS);
      const until = now.toISOString();
      return sys(async (tx) => {
        const b = schema.business;
        const businesses = await tx.select({ status: b.status, n: sql<number>`count(*)::int` }).from(b).groupBy(b.status);
        const ci = schema.consoleItem;
        const items = await tx.select({ kind: ci.kind, n: sql<number>`count(*)::int` }).from(ci).where(eq(ci.status, 'open')).groupBy(ci.kind);
        const t = schema.agentTurn;
        const [turns] = await tx
          .select({
            count: sql<number>`count(*)::int`,
            failed: sql<number>`(count(*) filter (where ${t.status} = 'failed'))::int`,
            handedOff: sql<number>`(count(*) filter (where ${t.status} = 'handed_off'))::int`,
            cost: sql<string | null>`sum(${t.costUsd})`,
          })
          .from(t)
          .where(sql`${t.startedAt} > ${since24h}::timestamptz and ${t.startedAt} <= ${until}::timestamptz`);
        const r = schema.modelRun;
        const failedRun = sql`(not ${r.valid} or ${r.error} is not null)`;
        const [runs] = await tx
          .select({
            count: sql<number>`count(*)::int`,
            failed: sql<number>`(count(*) filter (where ${failedRun}))::int`,
            cost: sql<string | null>`sum(${r.costUsd})`,
          })
          .from(r)
          .where(sql`${r.createdAt} > ${since24h}::timestamptz and ${r.createdAt} <= ${until}::timestamptz`);
        const dayOf = sql<string>`to_char(date_trunc('day', ${r.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
        const days = await tx
          .select({ day: dayOf, cost: sql<string | null>`sum(${r.costUsd})` })
          .from(r)
          .where(sql`${r.createdAt} >= ${firstDay.toISOString()}::timestamptz and ${r.createdAt} <= ${until}::timestamptz`)
          .groupBy(dayOf);
        const costOf = new Map(days.map((d) => [d.day, usd(d.cost)]));
        const p = schema.publication;
        const [pubs] = await tx
          .select({
            scheduled: sql<number>`(count(*) filter (where ${p.status} = 'scheduled'))::int`,
            published7d: sql<number>`(count(*) filter (where ${p.publishedAt} > ${since7d}::timestamptz and ${p.publishedAt} <= ${until}::timestamptz))::int`,
            failed: sql<number>`(count(*) filter (where ${p.status} = 'failed'))::int`,
          })
          .from(p);
        const failedRuns = await tx
          .select({ id: r.id, businessId: r.businessId, at: r.createdAt, label: r.task, error: r.error })
          .from(r)
          .where(failedRun)
          .orderBy(desc(r.createdAt))
          .limit(10);
        const failedPubs = await tx
          .select({ id: p.id, businessId: p.businessId, at: p.updatedAt, label: p.network, error: p.lastError })
          .from(p)
          .where(eq(p.status, 'failed'))
          .orderBy(desc(p.updatedAt))
          .limit(10);
        const recentFailures: FailureRow[] = [
          ...failedRuns.map((f) => ({ kind: 'model_run' as const, ...f })),
          ...failedPubs.map((f) => ({ kind: 'publication' as const, ...f })),
        ]
          .sort((x, y) => y.at.getTime() - x.at.getTime())
          .slice(0, 10);
        const recent = await tx
          .select({
            id: t.id,
            businessId: t.businessId,
            agent: t.agent,
            status: t.status,
            stopReason: t.stopReason,
            costUsd: t.costUsd,
            durationMs: t.durationMs,
            stepCount: sql<number>`jsonb_array_length(${t.steps})::int`,
            startedAt: t.startedAt,
          })
          .from(t)
          .orderBy(desc(t.startedAt))
          .limit(10);
        return {
          businesses: Object.fromEntries(businesses.map((x) => [x.status, Number(x.n)])),
          openItems: Object.fromEntries(items.map((x) => [x.kind, Number(x.n)])),
          agentTurns24h: { count: Number(turns?.count ?? 0), failed: Number(turns?.failed ?? 0), handedOff: Number(turns?.handedOff ?? 0), costUsd: usd(turns?.cost) },
          modelRuns24h: { count: Number(runs?.count ?? 0), failed: Number(runs?.failed ?? 0), costUsd: usd(runs?.cost) },
          costByDay: Array.from({ length: 14 }, (_, i) => {
            const day = utcDay(new Date(firstDay.getTime() + i * DAY_MS));
            return { day, usd: costOf.get(day) ?? 0 };
          }),
          publications: { scheduled: Number(pubs?.scheduled ?? 0), published7d: Number(pubs?.published7d ?? 0), failed: Number(pubs?.failed ?? 0) },
          recentFailures,
          recentTurns: recent.map((x) => ({ ...x, costUsd: usd(x.costUsd), stepCount: Number(x.stepCount) })),
        };
      });
    },

    businessRows: () => sys((tx) => businessRowsOf(tx)),

    async business(businessId) {
      return sys(async (tx) => {
        const [row] = await businessRowsOf(tx, businessId);
        if (!row) throw new ConsoleActionError(404, 'not_found');
        const b = schema.business;
        const [extra] = await tx.select({ profile: b.profile, style: b.style, timezone: b.timezone }).from(b).where(eq(b.id, businessId));
        const c = schema.channelConnection;
        const channels = await tx
          .select({ id: c.id, network: c.network, status: c.status, verifiedAt: c.verifiedAt, lastHealthCheckAt: c.lastHealthCheckAt })
          .from(c)
          .where(eq(c.businessId, businessId))
          .orderBy(asc(c.network));
        const s = schema.subscription;
        const [subscription] = await tx
          .select({ plan: s.plan, status: s.status, currentPeriodEnd: s.currentPeriodEnd, heldAt: s.heldAt })
          .from(s)
          .where(eq(s.businessId, businessId));
        const r = schema.modelRun;
        const since = new Date(Date.now() - DAY_MS).toISOString();
        const [cost] = await tx
          .select({ total: sql<string | null>`sum(${r.costUsd})`, last24h: sql<string | null>`sum(${r.costUsd}) filter (where ${r.createdAt} > ${since}::timestamptz)` })
          .from(r)
          .where(eq(r.businessId, businessId));
        return {
          ...row,
          profile: extra!.profile,
          style: extra!.style,
          timezone: extra!.timezone,
          channels,
          subscription: subscription ?? null,
          costUsd: { total: usd(cost?.total), last24h: usd(cost?.last24h) },
        };
      });
    },

    async posts(businessId) {
      return sys(async (tx) => {
        const p = schema.post;
        const w = schema.weeklyUpdate;
        const posts = await tx
          .select({
            id: p.id,
            businessId: p.businessId,
            status: p.status,
            format: p.format,
            position: p.position,
            weekStart: w.weekStart,
            currentVersionId: p.currentVersionId,
            updatedAt: p.updatedAt,
          })
          .from(p)
          .leftJoin(w, eq(w.id, p.weeklyUpdateId))
          .where(eq(p.businessId, businessId))
          .orderBy(desc(p.createdAt), desc(p.position))
          .limit(50);
        if (posts.length === 0) return [];
        const ids = posts.map((x) => x.id);
        const versions = await tx.select().from(schema.postVersion).where(inArray(schema.postVersion.postId, ids)).orderBy(desc(schema.postVersion.versionNumber));
        const approvals = await tx.select().from(schema.approval).where(inArray(schema.approval.postId, ids)).orderBy(desc(schema.approval.approvedAt));
        const pubs = await tx.select().from(schema.publication).where(inArray(schema.publication.postId, ids)).orderBy(asc(schema.publication.network));
        return posts.map(
          (x): PostDetail => ({
            ...x,
            versions: versions
              .filter((v) => v.postId === x.id)
              .map((v) => ({
                id: v.id,
                versionNumber: v.versionNumber,
                contentHash: v.contentHash,
                factCheckPassed: v.factCheckPassed,
                captions: (isRecord(v.captions) ? v.captions : {}) as PostDetail['versions'][number]['captions'],
                renderedMedia: (isRecord(v.renderedMedia) ? v.renderedMedia : {}) as Record<string, string[]>,
                createdAt: v.createdAt,
                approvals: approvals
                  .filter((a) => a.postVersionId === v.id)
                  .map((a) => ({ id: a.id, approvedAt: a.approvedAt, invalidatedAt: a.invalidatedAt, approvedVersionHash: a.approvedVersionHash })),
              })),
            publications: pubs
              .filter((u) => u.postId === x.id)
              .map((u) => ({
                id: u.id,
                network: u.network,
                status: u.status,
                scheduledFor: u.scheduledFor,
                publishedAt: u.publishedAt,
                attempts: u.attempts,
                lastError: u.lastError,
                approvedVersionHash: u.approvedVersionHash,
              })),
          }),
        );
      });
    },

    async modelRuns(businessId, limit = 100) {
      const rows = await sys((tx) =>
        tx
          .select(modelRunSummary)
          .from(schema.modelRun)
          .where(businessId ? eq(schema.modelRun.businessId, businessId) : undefined)
          .orderBy(desc(schema.modelRun.createdAt))
          .limit(Math.max(1, Math.min(500, Math.trunc(limit)))),
      );
      return rows.map((r) => ({ ...r, costUsd: usd(r.costUsd) }));
    },

    async modelRun(id) {
      const [row] = await sys((tx) => tx.select().from(schema.modelRun).where(eq(schema.modelRun.id, id)));
      if (!row) throw new ConsoleActionError(404, 'not_found');
      return row;
    },

    async mediaAsset(id) {
      const m = schema.mediaAsset;
      const [row] = await sys((tx) => tx.select({ storagePath: m.storagePath, mimeType: m.mimeType }).from(m).where(eq(m.id, id)));
      if (!row) throw new ConsoleActionError(404, 'not_found');
      return row;
    },

    async settings() {
      const [row] = await sys((tx) => tx.select().from(schema.systemControl).where(eq(schema.systemControl.id, 1)));
      return {
        publishingPaused: row?.publishingPaused ?? false,
        pausedReason: row?.pausedReason ?? null,
        pausedAt: row?.pausedAt ?? null,
        pausedBy: row?.pausedBy ?? null,
        agentDailyCostCapUsd: usd(row?.agentDailyCostCapUsd ?? '50'),
      };
    },

    modelTasks: () =>
      sys(async (tx) => {
        const rows = await tx.select().from(schema.modelTaskConfig).orderBy(asc(schema.modelTaskConfig.task));
        const versions = await promptVersionsOf(tx);
        return rows.map((r) => modelTaskRow(r, versions.get(r.task) ?? []));
      }),

    async agentConfigs() {
      const rows = await sys((tx) => tx.select().from(schema.agentConfig).orderBy(asc(schema.agentConfig.agent)));
      return rows.map(agentConfigRow);
    },

    actions: (businessId, limit = 200) =>
      sys((tx) =>
        tx
          .select()
          .from(schema.consoleAction)
          .where(businessId ? eq(schema.consoleAction.businessId, businessId) : undefined)
          .orderBy(desc(schema.consoleAction.createdAt))
          .limit(Math.max(1, Math.min(1000, Math.trunc(limit)))),
      ),

    async setProfile(businessId, profile, meta) {
      await sys(async (tx) => {
        const b = schema.business;
        const [current] = await tx
          .select({ status: b.status, profile: b.profile, approverPhone: b.approverPhone, name: b.name })
          .from(b)
          .where(eq(b.id, businessId))
          .for('update');
        if (!current) throw new ConsoleActionError(404, 'not_found');
        const parsed = (current.status === 'onboarding' ? BusinessProfileDraft : BusinessProfile).safeParse(profile);
        if (!parsed.success) throw new ConsoleActionError(400, 'invalid_profile', JSON.stringify(parsed.error.issues));
        const next = parsed.data as Record<string, unknown>;
        const stored = isRecord(current.profile) ? current.profile : {};
        // The approver number is part of the approval invariant and changes only with the owner. A draft
        // without a number yet may take only the business's own approver_phone.
        const same = next.approverPhone === stored.approverPhone || (stored.approverPhone === undefined && next.approverPhone === current.approverPhone);
        if (!same || (next.approverPhone !== undefined && next.approverPhone !== current.approverPhone)) {
          throw new ConsoleActionError(409, 'approver_locked', 'the approver number changes only with the owner');
        }
        const name = typeof next.name === 'string' ? next.name : current.name;
        await tx.update(b).set({ profile: next, name, updatedAt: new Date() }).where(eq(b.id, businessId));
        await record(tx, { businessId, action: 'profile', target: businessId, ...changedFields(stored, next) }, meta);
      });
    },

    async setAgentCostCap(value, meta) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw invalid('usd', 'greater than 0');
      await sys(async (tx) => {
        const s = schema.systemControl;
        const [row] = await tx.select({ cap: s.agentDailyCostCapUsd }).from(s).where(eq(s.id, 1)).for('update');
        const before = usd(row?.cap ?? '50');
        await tx
          .insert(s)
          .values({ id: 1, agentDailyCostCapUsd: String(value) })
          .onConflictDoUpdate({ target: s.id, set: { agentDailyCostCapUsd: String(value), updatedAt: new Date() } });
        await record(tx, { businessId: null, action: 'agent_cost_cap', target: 'agent_daily_cost_cap_usd', before: { usd: before }, after: { usd: value } }, meta);
      });
    },

    async setAgentConfig(agent, patch, meta) {
      if (!(AGENT_NAMES as readonly string[]).includes(agent)) throw new ConsoleActionError(404, 'not_found');
      const changes: Record<string, number> = {};
      for (const key of AGENT_INTEGER_LIMITS) {
        const v = patch[key];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw invalid(key, 'a positive integer');
        changes[key] = v;
      }
      for (const key of AGENT_COST_LIMITS) {
        const v = patch[key];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw invalid(key, 'greater than 0');
        changes[key] = v;
      }
      if (patch.minConfidence !== undefined) {
        const v = patch.minConfidence;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw invalid('minConfidence', 'between 0 and 1');
        changes.minConfidence = v;
      }
      if (Object.keys(changes).length === 0) throw invalid('patch', 'nothing to change');
      return sys(async (tx) => {
        const a = schema.agentConfig;
        const name = agent as (typeof AGENT_NAMES)[number];
        const [row] = await tx.select().from(a).where(eq(a.agent, name)).for('update');
        if (!row) throw new ConsoleActionError(404, 'not_found');
        const current = agentConfigRow(row) as unknown as Record<string, unknown>;
        const set = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, (AGENT_COST_LIMITS as readonly string[]).includes(k) ? String(v) : v]));
        const [updated] = await tx
          .update(a)
          .set({ ...set, updatedAt: new Date() })
          .where(eq(a.agent, name))
          .returning();
        const diff = changedFields(Object.fromEntries(Object.keys(changes).map((k) => [k, current[k]])), changes);
        await record(tx, { businessId: null, action: 'agent_config', target: agent, ...diff }, meta);
        return agentConfigRow(updated!);
      });
    },

    async setModelTask(task, patch, meta) {
      if (!(MODEL_TASK_NAMES as readonly string[]).includes(task)) throw new ConsoleActionError(404, 'not_found');
      const changes: Record<string, string | number | null> = {};
      if (patch.model !== undefined) {
        if (typeof patch.model !== 'string' || patch.model.trim() === '') throw invalid('model', 'a model name');
        changes.model = patch.model.trim();
      }
      if (patch.fallbackModel !== undefined) {
        const v = patch.fallbackModel;
        if (v !== null && (typeof v !== 'string' || v.trim() === '')) throw invalid('fallbackModel', 'a model name or null');
        changes.fallbackModel = v === null ? null : v.trim();
      }
      if (patch.temperature !== undefined) {
        const v = patch.temperature;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 2) throw invalid('temperature', 'between 0 and 2');
        changes.temperature = v;
      }
      if (patch.maxCostUsd !== undefined) {
        const v = patch.maxCostUsd;
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw invalid('maxCostUsd', 'greater than 0');
        changes.maxCostUsd = v;
      }
      if (patch.maxRetries !== undefined) {
        const v = patch.maxRetries;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 5) throw invalid('maxRetries', 'an integer from 0 to 5');
        changes.maxRetries = v;
      }
      if (patch.activePromptVersion !== undefined) {
        const v = patch.activePromptVersion;
        if (typeof v !== 'number' || !Number.isInteger(v)) throw new ConsoleActionError(400, 'unknown_prompt_version', String(v));
        changes.activePromptVersion = v;
      }
      if (Object.keys(changes).length === 0) throw invalid('patch', 'nothing to change');
      return sys(async (tx) => {
        const m = schema.modelTaskConfig;
        const name = task as (typeof MODEL_TASK_NAMES)[number];
        const [row] = await tx.select().from(m).where(eq(m.task, name)).for('update');
        if (!row) throw new ConsoleActionError(404, 'not_found');
        const versions = (await promptVersionsOf(tx, name)).get(name) ?? [];
        if (changes.activePromptVersion !== undefined && !versions.includes(changes.activePromptVersion as number)) {
          throw new ConsoleActionError(400, 'unknown_prompt_version', `${task} has no prompt version ${changes.activePromptVersion}`);
        }
        const current = modelTaskRow(row, versions) as unknown as Record<string, unknown>;
        const set = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, k === 'maxCostUsd' ? String(v) : v]));
        const [updated] = await tx
          .update(m)
          .set({ ...set, updatedAt: new Date() })
          .where(eq(m.task, name))
          .returning();
        const diff = changedFields(Object.fromEntries(Object.keys(changes).map((k) => [k, current[k]])), changes);
        await record(tx, { businessId: null, action: 'model_task_config', target: task, ...diff }, meta);
        return modelTaskRow(updated!, versions);
      });
    },
  };
}
