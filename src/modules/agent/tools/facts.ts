import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AgentToolResult } from '../../../contracts/agent.js';
import { Fact } from '../../../contracts/content.js';
import * as schema from '../../../db/schema.js';
import { normalize, quoteIn } from '../checks.js';
import type { ToolContext, ToolHandlers, ToolOutcome } from '../types.js';

// record_fact (WP-93; agent.md, record_fact): one fact of the current week's update, quoted from the
// owner's own words this week. Also the week helpers plan_posts shares (tools/plan.ts).

const ok = (data: Record<string, unknown>): ToolOutcome => ({ result: { status: 'ok', data } });
export const refused = (reason: Extract<AgentToolResult, { status: 'refused' }>['reason'], detail: string): ToolOutcome => ({
  result: { status: 'refused', reason, detail },
});

/** Fact types whose value must appear in the quote (agent.md, record_fact). */
const VALUE_IN_QUOTE = new Set(['price', 'discount_percent', 'date', 'time', 'phone']);

const StoredFacts = z.object({ facts: z.array(Fact), missingDetails: z.array(z.string()).default([]) });

export interface CurrentWeek {
  id: string;
  status: string;
  facts: Fact[];
  missingDetails: string[];
  /** Photos of this week: the update's, then those the owner sent after it. */
  photos: string[];
  /** What the owner typed this week: the update and every later message. */
  typed: string[];
  /** The voice notes' transcript, when the update had any. */
  transcript: string;
}

/**
 * The business's newest week and the owner's words in it. "This week" is the update and everything
 * the owner sent after it (answers to the agent's questions); older messages are not sources.
 */
export async function currentWeek(ctx: ToolContext): Promise<CurrentWeek | null> {
  return ctx.deps.db.withBusiness('workflow', ctx.businessId, async (tx) => {
    const [week] = await tx
      .select()
      .from(schema.weeklyUpdate)
      .where(eq(schema.weeklyUpdate.businessId, ctx.businessId))
      .orderBy(desc(schema.weeklyUpdate.weekStart))
      .limit(1);
    if (!week) return null;
    const stored = StoredFacts.safeParse(week.extractedFacts);
    const since = week.receivedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const later = ctx.context.messages.filter((m) => m.role === 'owner' && new Date(m.at).getTime() >= since);
    return {
      id: week.id,
      status: week.status,
      facts: stored.success ? stored.data.facts : [],
      missingDetails: stored.success ? stored.data.missingDetails : [],
      photos: [...new Set([...week.mediaAssetIds, ...later.flatMap((m) => m.photos.map((p) => p.assetId))])],
      typed: [week.originalText ?? '', ...later.map((m) => m.text)].filter((t) => t.trim() !== ''),
      transcript: week.transcript ?? '',
    };
  });
}

/** True when `quote` is in the owner's words this week: typed text, and the transcript unless `typedOnly`. */
export function inWeek(week: CurrentWeek, quote: string, typedOnly = false): boolean {
  return [...week.typed, ...(typedOnly ? [] : [week.transcript])].some((source) => quoteIn(quote, source));
}

/** A value appears in its quote: as text, or (for numbers) every digit group of it does. */
function valueInQuote(value: string, quote: string): boolean {
  if (normalize(quote).includes(normalize(value))) return true;
  const groups = value.match(/\d+/gu);
  const quoted = new Set(quote.match(/\d+/gu) ?? []);
  return groups !== null && groups.every((g) => quoted.has(g));
}

export const factsTools: ToolHandlers = {
  async record_fact(call, ctx) {
    const week = await currentWeek(ctx);
    if (week?.status !== 'received') return refused('not_allowed', 'there is no weekly update being gathered now');
    if (!inWeek(week, call.sourceQuote, call.type === 'testimonial')) {
      return refused(
        'quote_not_found',
        call.type === 'testimonial' ? 'a testimonial must be quoted from text the owner typed this week' : "the quote is not in the owner's update or answers this week",
      );
    }
    if (VALUE_IN_QUOTE.has(call.type) && !valueInQuote(call.value, call.sourceQuote)) {
      return refused('value_not_in_quote', `"${call.value}" does not appear in the quote`);
    }
    if (call.replaces !== undefined && !week.facts.some((f) => f.id === call.replaces)) return refused('unknown_id', `no fact ${call.replaces} this week`);

    const used = week.facts.map((f) => Number(f.id.replace(/^f/u, ''))).filter(Number.isFinite);
    const id = `f${Math.max(0, ...used) + 1}`;
    const facts = [...week.facts.filter((f) => f.id !== call.replaces), { id, type: call.type, value: call.value, sourceQuote: call.sourceQuote }];
    await ctx.deps.db.withBusiness('workflow', ctx.businessId, (tx) =>
      tx
        .update(schema.weeklyUpdate)
        .set({ extractedFacts: { facts, missingDetails: week.missingDetails }, updatedAt: new Date() })
        .where(eq(schema.weeklyUpdate.id, week.id)),
    );
    return ok({ factId: id });
  },
};
