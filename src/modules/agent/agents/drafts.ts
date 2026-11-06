import { desc, eq } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';
import type { AgentDefinition } from '../types.js';

// The drafts agent (WP-94; agent.md, Agents): writes the captions, hashtags, title, an optional badge,
// the photo edits and the carousel order of each post (create_draft), and applies the owner's fixes
// (apply_change). Code decides "done": no post of the week is still being drafted, and the workflow
// then applies DRAFTS_SENT.
export const draftsAgent: AgentDefinition = {
  name: 'drafts',
  task: 'agent_drafts',
  tools: ['create_draft', 'apply_change', 'ask_owner', 'request_photo', 'plan_posts', 'record_decline', 'hand_off_to_console', 'end_turn'],
  doneRule:
    'Done when every post of the week has a draft waiting for the owner (create_draft, or apply_change after a fix), or waits for an answer, or went to the team: no post is still planned or drafting.',
  isDone: async ({ businessId, db }) => {
    const rows = await db.withBusiness('workflow', businessId, async (tx) => {
      const [week] = await tx
        .select({ id: schema.weeklyUpdate.id })
        .from(schema.weeklyUpdate)
        .where(eq(schema.weeklyUpdate.businessId, businessId))
        .orderBy(desc(schema.weeklyUpdate.weekStart))
        .limit(1);
      if (!week) return [];
      return tx.select({ status: schema.post.status }).from(schema.post).where(eq(schema.post.weeklyUpdateId, week.id));
    });
    return rows.length > 0 && rows.every((p) => p.status !== 'planned' && p.status !== 'drafting');
  },
};
