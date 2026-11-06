import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../../../db/schema.js';
import type { AgentDefinition } from '../types.js';

// The drafts agent (WP-94; agent.md, Agents): writes the captions, hashtags, title, an optional badge,
// the photo edits and the carousel order of each post (create_draft), and applies the owner's fixes
// (apply_change). Code decides "done": no post of the week is still being drafted, and the workflow
// then applies DRAFTS_SENT.

/** The turn's recorded steps (agent_turn.steps): each call with its result, written after every call. */
const Steps = z.array(z.object({ calls: z.array(z.object({ call: z.object({ tool: z.string() }), result: z.object({ status: z.string() }) })) }));

export const draftsAgent: AgentDefinition = {
  name: 'drafts',
  task: 'agent_drafts',
  tools: ['create_draft', 'apply_change', 'ask_owner', 'request_photo', 'plan_posts', 'record_decline', 'hand_off_to_console', 'end_turn'],
  doneRule:
    'Done when no post of the week is still planned or drafting, and, on an owner message (a fix or an answer), a draft was written in this turn (create_draft or apply_change succeeded).',
  isDone: async ({ businessId, db, turnId }) => {
    const { posts, turn } = await db.withBusiness('workflow', businessId, async (tx) => {
      const [week] = await tx
        .select({ id: schema.weeklyUpdate.id })
        .from(schema.weeklyUpdate)
        .where(eq(schema.weeklyUpdate.businessId, businessId))
        .orderBy(desc(schema.weeklyUpdate.weekStart))
        .limit(1);
      const [row] = await tx.select({ trigger: schema.agentTurn.trigger, steps: schema.agentTurn.steps }).from(schema.agentTurn).where(and(eq(schema.agentTurn.businessId, businessId), eq(schema.agentTurn.id, turnId)));
      return { posts: week ? await tx.select({ status: schema.post.status }).from(schema.post).where(eq(schema.post.weeklyUpdateId, week.id)) : [], turn: row };
    });
    if (posts.length === 0 || posts.some((p) => p.status === 'planned' || p.status === 'drafting')) return false;
    // A turn started by the plan (an event) is done once every post has its draft. A turn started by
    // the owner's message must have written one first: a fix leaves its post waiting for approval the
    // whole time, so the posts alone cannot tell that the fix was applied.
    const burst = (turn?.trigger as { kind?: string } | undefined)?.kind === 'burst';
    if (!burst) return true;
    const steps = Steps.safeParse(turn?.steps);
    return steps.success && steps.data.some((s) => s.calls.some((c) => (c.call.tool === 'create_draft' || c.call.tool === 'apply_change') && c.result.status === 'ok'));
  },
};
