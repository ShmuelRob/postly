import { and, eq, sql } from 'drizzle-orm';
import { BUSINESS_STATES } from '../../contracts/state-machines/business.js';
import { CONVERSATION_STATES } from '../../contracts/state-machines/conversation.js';
import { ONBOARDING_STEPS } from '../../contracts/state-machines/onboarding.js';
import type { Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import type { Insights, InsightsRange } from './views.js';

// The Insights tab's numbers (technical-design.md, "Console (Phase 1)"; definitions in views.ts,
// Insights). Read inside one withSystem('console') transaction by console.ts.

const DAY_MS = 86_400_000;
const MAX_DAYS = 366;
const DONE_WEEKLY = ['received', 'needs_review', 'planned'];

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

/** The range as instants (start of `from`, start of the day after `to`, UTC) and its days; null when invalid. */
export function parseRange(range: InsightsRange): { start: Date; end: Date; days: string[] } | null {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(range.from) || !day.test(range.to)) return null;
  const start = new Date(`${range.from}T00:00:00Z`);
  const last = new Date(`${range.to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(last.getTime()) || isoDay(start) !== range.from || isoDay(last) !== range.to) return null;
  const count = Math.round((last.getTime() - start.getTime()) / DAY_MS) + 1;
  if (count < 1 || count > MAX_DAYS) return null;
  const days = Array.from({ length: count }, (_, i) => isoDay(new Date(start.getTime() + i * DAY_MS)));
  return { start, end: new Date(last.getTime() + DAY_MS), days };
}

/** The last `days` UTC days ending today (the Insights default is 30). */
export function lastDays(days: number, now = new Date()): InsightsRange {
  const to = isoDay(now);
  return { from: isoDay(new Date(new Date(`${to}T00:00:00Z`).getTime() - (days - 1) * DAY_MS)), to };
}

/** The Sunday on or before a UTC day. */
const sundayOf = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  return isoDay(new Date(d.getTime() - d.getUTCDay() * DAY_MS));
};

export async function readInsights(tx: Tx, range: InsightsRange, bounds: NonNullable<ReturnType<typeof parseRange>>, now: Date): Promise<Insights> {
  const from = bounds.start.toISOString();
  const to = bounds.end.toISOString();
  const within = (column: unknown) => sql`${column} >= ${from}::timestamptz and ${column} < ${to}::timestamptz`;
  const dayOf = (column: unknown) => sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD')`;

  // New businesses per day.
  const b = schema.business;
  const created = await tx
    .select({ day: dayOf(b.createdAt), n: sql<number>`count(*)::int` })
    .from(b)
    .where(within(b.createdAt))
    .groupBy(dayOf(b.createdAt));
  const createdOn = new Map(created.map((r) => [r.day, r.n]));
  const perDay = bounds.days.map((day) => ({ day, n: createdOn.get(day) ?? 0 }));
  const weeks = new Map<string, number>();
  for (const d of perDay) weeks.set(sundayOf(d.day), (weeks.get(sundayOf(d.day)) ?? 0) + d.n);

  // Statuses and the funnel, now.
  const statusRows = await tx.select({ status: b.status, n: sql<number>`count(*)::int` }).from(b).groupBy(b.status);
  const statusOf = new Map(statusRows.map((r) => [r.status as string, r.n]));
  const cs = schema.conversationState;
  const stepRows = await tx
    .select({ status: b.status, step: cs.step, n: sql<number>`count(*)::int` })
    .from(b)
    .leftJoin(cs, eq(cs.businessId, b.id))
    .where(sql`${b.status} in ('onboarding', 'active')`)
    .groupBy(b.status, cs.step);
  const funnelOf = (status: string, steps: readonly string[]) => {
    const counts = new Map<string, number>(steps.map((s) => [s, 0]));
    for (const r of stepRows.filter((x) => x.status === status)) {
      const step = r.step && counts.has(r.step) ? r.step : steps[0]!;
      counts.set(step, (counts.get(step) ?? 0) + r.n);
    }
    return steps.map((step) => ({ step, n: counts.get(step) ?? 0 }));
  };

  // Messages.
  const m = schema.message;
  const perBusiness = await tx
    .select({
      businessId: m.businessId,
      name: b.name,
      inbound: sql<number>`(count(*) filter (where ${m.direction} = 'inbound'))::int`,
      outbound: sql<number>`(count(*) filter (where ${m.direction} = 'outbound'))::int`,
    })
    .from(m)
    .innerJoin(b, eq(b.id, m.businessId))
    .where(within(m.createdAt))
    .groupBy(m.businessId, b.name);
  const top = perBusiness
    .map((r) => ({ businessId: r.businessId!, name: r.name, inbound: r.inbound, outbound: r.outbound }))
    .sort((x, y) => y.inbound + y.outbound - (x.inbound + x.outbound) || x.name.localeCompare(y.name))
    .slice(0, 20);

  // Posts, approvals and publications.
  const v = schema.postVersion;
  const a = schema.approval;
  // A join, not a correlated subquery: drizzle leaves column names unqualified inside a sql`` subquery,
  // which would compare approval.post_id with itself.
  const firstVersions = await tx
    .select({
      drafted: sql<number>`count(distinct ${v.id})::int`,
      approved: sql<number>`(count(distinct ${v.postId}) filter (where ${a.id} is not null))::int`,
    })
    .from(v)
    .leftJoin(a, eq(a.postId, v.postId))
    .where(and(eq(v.versionNumber, 1), within(v.createdAt)));
  const drafted = firstVersions[0]?.drafted ?? 0;
  const approvedOfDrafted = firstVersions[0]?.approved ?? 0;
  const [approvedPosts] = await tx
    .select({ n: sql<number>`count(distinct ${a.postId})::int` })
    .from(a)
    .where(and(within(a.approvedAt), sql`${a.invalidatedAt} is null`));
  const minutes = sql`extract(epoch from (${a.approvedAt} - ${v.createdAt})) / 60`;
  const [times] = await tx
    .select({
      median: sql<string | null>`percentile_cont(0.5) within group (order by ${minutes})`,
      p90: sql<string | null>`percentile_cont(0.9) within group (order by ${minutes})`,
    })
    .from(a)
    .innerJoin(v, eq(v.id, a.postVersionId))
    .where(within(a.approvedAt));
  const p = schema.publication;
  const networks = await tx
    .select({
      network: p.network,
      scheduled: sql<number>`(count(*) filter (where ${within(p.scheduledFor)}))::int`,
      published: sql<number>`(count(*) filter (where ${within(p.publishedAt)}))::int`,
      failed: sql<number>`(count(*) filter (where ${p.status} = 'failed' and ${within(p.updatedAt)}))::int`,
    })
    .from(p)
    .where(sql`${within(p.scheduledFor)} or ${within(p.publishedAt)} or (${p.status} = 'failed' and ${within(p.updatedAt)})`)
    .groupBy(p.network)
    .orderBy(p.network);
  const byNetwork = networks.map((r) => ({ network: r.network as string, scheduled: r.scheduled, published: r.published, failed: r.failed }));

  // This week's weekly update.
  const weekStart = sundayOf(isoDay(now));
  const w = schema.weeklyUpdate;
  const weekRows = await tx
    .select({ status: w.status, n: sql<number>`count(*)::int` })
    .from(w)
    .innerJoin(b, eq(b.id, w.businessId))
    .where(and(eq(w.weekStart, weekStart), eq(b.status, 'active')))
    .groupBy(w.status);
  const weekly = (statuses: string[]) => weekRows.filter((r) => statuses.includes(r.status)).reduce((s, r) => s + r.n, 0);
  const active = statusOf.get('active') ?? 0;
  const withRow = weekRows.reduce((s, r) => s + r.n, 0);

  // Agent turns.
  const t = schema.agentTurn;
  const [turns] = await tx
    .select({ turns: sql<number>`count(*)::int`, handedOff: sql<number>`(count(*) filter (where ${t.status} = 'handed_off'))::int` })
    .from(t)
    .where(within(t.startedAt));

  // Model cost.
  const r = schema.modelRun;
  const costDays = await tx
    .select({ day: dayOf(r.createdAt), usd: sql<string | null>`sum(${r.costUsd})` })
    .from(r)
    .where(within(r.createdAt))
    .groupBy(dayOf(r.createdAt));
  const costOn = new Map(costDays.map((d) => [d.day, num(d.usd)]));
  const [spenders] = await tx
    .select({ n: sql<number>`count(distinct ${r.businessId})::int` })
    .from(r)
    .where(and(within(r.createdAt), sql`${r.businessId} is not null`, sql`${r.costUsd} > 0`));
  const totalUsd = [...costOn.values()].reduce((s, x) => s + x, 0);
  const [businessSpend] = await tx
    .select({ usd: sql<string | null>`sum(${r.costUsd})` })
    .from(r)
    .where(and(within(r.createdAt), sql`${r.businessId} is not null`));

  return {
    range: { ...range, days: bounds.days.length },
    newBusinesses: { total: perDay.reduce((s, d) => s + d.n, 0), perDay, perWeek: [...weeks].map(([weekStart, n]) => ({ weekStart, n })) },
    statuses: Object.fromEntries(BUSINESS_STATES.map((s) => [s, statusOf.get(s) ?? 0])),
    funnel: { onboarding: funnelOf('onboarding', ONBOARDING_STEPS), conversation: funnelOf('active', CONVERSATION_STATES) },
    messages: {
      inbound: perBusiness.reduce((s, x) => s + x.inbound, 0),
      outbound: perBusiness.reduce((s, x) => s + x.outbound, 0),
      businessesWriting: perBusiness.filter((x) => x.inbound > 0).length,
      top,
    },
    posts: { drafted, approved: approvedPosts?.n ?? 0, published: byNetwork.reduce((s, x) => s + x.published, 0), byNetwork },
    weekly: {
      weekStart,
      active,
      done: weekly(DONE_WEEKLY),
      reminded: weekly(['reminded']),
      awaiting: weekly(['awaiting']),
      skipped: weekly(['skipped']),
      noRow: Math.max(0, active - withRow),
    },
    approval: {
      versioned: drafted,
      approved: approvedOfDrafted,
      rate: drafted ? approvedOfDrafted / drafted : null,
      medianMinutes: times?.median === null || times?.median === undefined ? null : Number(times.median),
      p90Minutes: times?.p90 === null || times?.p90 === undefined ? null : Number(times.p90),
    },
    agent: { turns: turns?.turns ?? 0, handedOff: turns?.handedOff ?? 0, handOffRate: turns?.turns ? turns.handedOff / turns.turns : null },
    cost: {
      totalUsd,
      perDay: bounds.days.map((day) => ({ day, usd: costOn.get(day) ?? 0 })),
      perBusinessUsd: spenders?.n ? num(businessSpend?.usd) / spenders.n : null,
    },
  };
}
