import { desc, eq } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';
import type { AgentDefinition } from '../types.js';

// The weekly-update agent (WP-93; agent.md, Agents): records the week's facts one by one, asks about a
// missing detail or a photo, and plans the week. Code decides "done": the plan passed its checks and
// the workflow stored it (FACTS_EXTRACTED), so the week is `planned`.
export const weeklyAgent: AgentDefinition = {
  name: 'weekly',
  task: 'agent_weekly',
  tools: ['ask_owner', 'record_fact', 'request_photo', 'record_decline', 'plan_posts', 'set_profile_field', 'hand_off_to_console', 'end_turn'],
  doneRule:
    "Done when plan_posts (mode initial) passes: every fact a planned post depends on is recorded with record_fact or declined with record_decline, and the plan has the profile's posts per week unless the owner asked for another number this week.",
  isDone: async ({ businessId, db }) => {
    const [week] = await db.withBusiness('workflow', businessId, (tx) =>
      tx
        .select({ status: schema.weeklyUpdate.status })
        .from(schema.weeklyUpdate)
        .where(eq(schema.weeklyUpdate.businessId, businessId))
        .orderBy(desc(schema.weeklyUpdate.weekStart))
        .limit(1),
    );
    return week?.status === 'planned';
  },
};
