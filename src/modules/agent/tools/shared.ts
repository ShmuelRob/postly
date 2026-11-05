import { and, eq } from 'drizzle-orm';
import type { AgentToolResult } from '../../../contracts/agent.js';
import { WindowClosedError } from '../../../contracts/providers/messaging.js';
import * as schema from '../../../db/schema.js';
import { latestOwnerText, ownerTextProblem, quoteIn } from '../checks.js';
import { handOff } from '../handoff.js';
import type { ToolContext, ToolHandlers, ToolOutcome } from '../types.js';

// The tools every agent shares (agent.md, Tools): ask_owner, request_photo, record_decline,
// hand_off_to_console and end_turn. WP-90; the agent packages add their own files next to this one.

const ok = (data: Record<string, unknown> = {}): ToolOutcome => ({ result: { status: 'ok', data } });
const refused = (reason: Extract<AgentToolResult, { status: 'refused' }>['reason'], detail: string): ToolOutcome => ({
  result: { status: 'refused', reason, detail },
});

/** At most two messages to the owner per turn, and one that expects an answer (agent.md, ask_owner). */
const MAX_MESSAGES_PER_TURN = 2;
/** At most two photo requests per post (agent.md, request_photo). */
const MAX_PHOTO_REQUESTS_PER_POST = 2;

async function postExists(ctx: ToolContext, postId: string): Promise<boolean> {
  const rows = await ctx.deps.db.withBusiness('workflow', ctx.businessId, (tx) =>
    tx
      .select({ id: schema.post.id })
      .from(schema.post)
      .where(and(eq(schema.post.businessId, ctx.businessId), eq(schema.post.id, postId))),
  );
  return rows.length > 0;
}

/** Checks a message for the owner and sends it; the turn's counters move only when it is sent. */
async function sendToOwner(ctx: ToolContext, text: string, expectsAnswer: boolean): Promise<ToolOutcome | null> {
  if (ctx.turn.messagesSent >= MAX_MESSAGES_PER_TURN) return refused('question_limit', 'at most two messages to the owner in one turn');
  if (expectsAnswer && ctx.turn.questionsAsked >= 1) return refused('question_limit', 'at most one question in one turn');
  const problem = ownerTextProblem(text, ctx.context);
  if (problem) return refused(problem.reason, problem.detail);
  try {
    await ctx.deps.messaging.sendText(ctx.businessId, { to: ctx.approverPhone, text });
  } catch (error) {
    if (error instanceof WindowClosedError) return refused('window_closed', 'the owner has not written in 24 hours; only a template can go out');
    throw error;
  }
  ctx.turn.messagesSent += 1;
  if (expectsAnswer) ctx.turn.questionsAsked += 1;
  return null;
}

export const sharedTools: ToolHandlers = {
  async ask_owner(call, ctx) {
    const asked = ctx.history.filter((h) => h.call.tool === 'ask_owner' && h.call.topic === call.topic && h.call.expects === 'answer').length;
    if (call.expects === 'answer' && asked >= ctx.limits.maxRepeatedQuestions) {
      return { ...refused('question_limit', `"${call.topic}" was already asked ${asked} times`), stop: 'stuck' };
    }
    const problem = await sendToOwner(ctx, call.text, call.expects === 'answer');
    if (problem) return problem;
    if (call.expects === 'none') return ok({ sent: true });
    await ctx.deps.events.questionAsked(ctx.businessId, { agent: ctx.agent, key: call.topic, askedFields: call.fields ?? [] });
    return { ...ok({ sent: true }), stop: 'waiting_for_owner' };
  },

  async request_photo(call, ctx) {
    if (call.postId) {
      if (!(await postExists(ctx, call.postId))) return refused('unknown_id', 'no such post in this business');
      const requested = ctx.history.filter((h) => h.call.tool === 'request_photo' && h.call.postId === call.postId).length;
      if (requested >= MAX_PHOTO_REQUESTS_PER_POST) return refused('photo_request_limit', 'at most two photo requests for one post');
    }
    const problem = await sendToOwner(ctx, call.text, true);
    if (problem) return problem;
    await ctx.deps.events.questionAsked(ctx.businessId, {
      agent: ctx.agent,
      key: `photo_request:${call.purpose}`,
      askedFields: [],
      ...(call.postId ? { postId: call.postId } : {}),
    });
    return { ...ok({ sent: true }), stop: 'waiting_for_owner' };
  },

  async record_decline(call, ctx) {
    if (!quoteIn(call.ownerQuote, latestOwnerText(ctx.context))) return refused('quote_not_found', "the quote is not in the owner's latest message");
    if (call.postId && !(await postExists(ctx, call.postId))) return refused('unknown_id', 'no such post in this business');
    return ok({ declined: call.what });
  },

  async hand_off_to_console(call, ctx) {
    await handOff(ctx.deps, {
      businessId: ctx.businessId,
      turnId: ctx.turnId,
      kind: 'handoff',
      details: { reason: call.reason, note: call.note, agent: ctx.agent },
      approverPhone: ctx.approverPhone,
      personaName: ctx.personaName,
      now: ctx.deps.now(),
    });
    return { ...ok({ handedOff: true }), stop: 'handed_off' };
  },

  async end_turn() {
    return { ...ok(), stop: 'end_turn' };
  },
};
