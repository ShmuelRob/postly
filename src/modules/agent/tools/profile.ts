import { eq } from 'drizzle-orm';
import { type AgentProfileField, profileFieldValueSchema, QUOTED_PROFILE_FIELDS } from '../../../contracts/agent.js';
import { BusinessProfileDraft } from '../../../contracts/business-profile.js';
import * as schema from '../../../db/schema.js';
import { normalize } from '../checks.js';
import { WindowClosedError } from '../../../contracts/providers/messaging.js';
import type { ToolContext, ToolHandlers, ToolOutcome } from '../types.js';
import { profileChanged } from './profile-copy.js';

// set_profile_field (WP-92, agent.md, Tools). Sets one field of the onboarding draft, or of the
// active profile (A7). A nested field (location.city) is saved only once its whole object is valid:
// until then its parts are kept in this onboarding's earlier tool calls (the turn history), so the
// stored profile is always a valid BusinessProfileDraft and the agent's context never loses it.

const refused = (reason: 'quote_not_found' | 'value_not_in_quote' | 'not_allowed' | 'invalid_input', detail: string): ToolOutcome => ({
  result: { status: 'refused', reason, detail },
});

/** Every owner message in the context: a quote may come from any of them, not only the latest. */
const ownerWords = (ctx: ToolContext) =>
  normalize(
    ctx.context.messages
      .filter((m) => m.role === 'owner')
      .map((m) => m.text)
      .join('\n'),
  );

/** Digit groups of a value: hours, phone digits, a house number (agent.md, set_profile_field). */
const digitGroups = (value: unknown) => (JSON.stringify(value).match(/\d+/gu) ?? []).map((d) => d.replace(/^0+(?=\d)/u, ''));

/** The digits of a phone written in +972 form also match its local 0 form. */
function digitsIn(quote: string): Set<string> {
  const groups = new Set<string>();
  for (const g of quote.match(/\d+/gu) ?? []) {
    groups.add(g.replace(/^0+(?=\d)/u, ''));
  }
  const phoneDigits = quote.replace(/\D+/gu, '');
  if (phoneDigits) groups.add(phoneDigits.replace(/^0+/u, ''));
  return groups;
}

/**
 * Every number in the value is in the quote, or in the field's saved value: a correction ("on
 * Friday we close at 13:00") keeps the numbers the owner gave before.
 */
function numbersMatch(value: unknown, quote: string, saved: unknown): boolean {
  const have = digitsIn(`${quote} ${saved === undefined ? '' : JSON.stringify(saved)}`);
  // Every number is a whole digit group of the quote or the saved value ("2" never matches inside
  // "20"). Only a phone has a second form: +972501234567 against 050-1234567, by its national number.
  return digitGroups(value).every((g) => have.has(g) || (g.startsWith('972') && g.length >= 11 && have.has(g.slice(3))));
}

/** The parts of a nested object set by earlier successful calls in this onboarding, oldest first. */
function earlierParts(ctx: ToolContext, top: string): Record<string, unknown> {
  const parts: Record<string, unknown> = {};
  for (const h of ctx.history) {
    if (h.call.tool !== 'set_profile_field') continue;
    const [t, sub] = h.call.field.split('.');
    if (t === top && sub) parts[sub] = h.call.value;
  }
  return parts;
}

export const profileTools: ToolHandlers = {
  async set_profile_field(call, ctx) {
    const field = call.field as AgentProfileField;
    const [top, sub] = field.split('.') as [keyof BusinessProfileDraft, string | undefined];

    const [business] = await ctx.deps.db.withBusiness('workflow', ctx.businessId, (tx) =>
      tx.select({ status: schema.business.status, profile: schema.business.profile }).from(schema.business).where(eq(schema.business.id, ctx.businessId)),
    );
    if (!business) return refused('invalid_input', 'business not found');
    // A7: the channels are chosen in onboarding; after it, a channel change goes through the team.
    if (field === 'channels' && business.status !== 'onboarding') return refused('not_allowed', 'channels change only during onboarding');

    const draft = BusinessProfileDraft.safeParse(business.profile);
    const current: Record<string, unknown> = draft.success ? { ...draft.data } : {};
    const savedTop = current[top];
    const saved = sub && savedTop && typeof savedTop === 'object' ? (savedTop as Record<string, unknown>)[sub] : sub ? undefined : savedTop;

    if (call.sourceQuote !== undefined) {
      if (!ownerWords(ctx).includes(normalize(call.sourceQuote))) return refused('quote_not_found', "the quote is not in the owner's messages");
      if (QUOTED_PROFILE_FIELDS.includes(field) && !numbersMatch(call.value, call.sourceQuote, saved)) {
        return refused('value_not_in_quote', 'a number in the value is not in the quote or the saved value');
      }
    }

    let value: unknown = profileFieldValueSchema(field).parse(call.value);
    if (sub) {
      const existing = current[top];
      const base = existing && typeof existing === 'object' ? (existing as Record<string, unknown>) : earlierParts(ctx, top);
      const merged = { ...base, [sub]: value };
      const whole = BusinessProfileDraft.shape[top].safeParse(merged);
      if (!whole.success || whole.data === undefined) {
        const missing = [...new Set(whole.error?.issues.map((i) => String(i.path[0])) ?? [])].filter((k) => !(k in merged));
        return { result: { status: 'ok', data: { field, saved: false, waitingFor: missing.map((k) => `${top}.${k}`) } } };
      }
      value = whole.data;
    }

    const next = BusinessProfileDraft.parse({ ...current, [top]: value });
    await ctx.deps.db.withBusiness('workflow', ctx.businessId, (tx) =>
      tx
        .update(schema.business)
        .set({ profile: { ...(business.profile as object), ...next }, ...(top === 'name' && next.name ? { name: next.name } : {}), updatedAt: new Date() })
        .where(eq(schema.business.id, ctx.businessId)),
    );
    // A7: on an active business, code (not the agent) tells the owner exactly what changed.
    if (business.status !== 'onboarding') {
      try {
        await ctx.deps.messaging.sendText(ctx.businessId, { to: ctx.approverPhone, text: profileChanged(field, next[top]) });
      } catch (error) {
        if (!(error instanceof WindowClosedError)) throw error;
      }
    }
    return { result: { status: 'ok', data: { field, saved: true } } };
  },
};
