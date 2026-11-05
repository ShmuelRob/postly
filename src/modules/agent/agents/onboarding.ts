import { and, eq } from 'drizzle-orm';
import { AgentToolCall, AgentToolResult } from '../../../contracts/agent.js';
import { BusinessProfileDraft, missingRequiredProfileFields } from '../../../contracts/business-profile.js';
import { OpenQuestion } from '../../../contracts/open-question.js';
import type { Database } from '../../../db/index.js';
import * as schema from '../../../db/schema.js';
import type { AgentDefinition } from '../types.js';

// The onboarding agent (WP-92, agent.md: Agents, How it fits the state machines). It runs in the
// onboarding steps profile_questions and brand_assets, and for corrections in profile_review. Code
// decides "done"; the onboarding flow then applies the step's event.

type Call = { turnId: string; call: AgentToolCall; result: AgentToolResult };

/** Every recorded call of this business's onboarding turns, oldest first. */
async function onboardingCalls(db: Database, businessId: string): Promise<Call[]> {
  const turns = await db.withBusiness('workflow', businessId, (tx) =>
    tx
      .select({ id: schema.agentTurn.id, steps: schema.agentTurn.steps })
      .from(schema.agentTurn)
      .where(and(eq(schema.agentTurn.businessId, businessId), eq(schema.agentTurn.agent, 'onboarding')))
      .orderBy(schema.agentTurn.startedAt),
  );
  return turns.flatMap((t) =>
    (t.steps as { calls: { call: unknown; result: unknown }[] }[]).flatMap((s) =>
      s.calls.flatMap(({ call, result }) => {
        const c = AgentToolCall.safeParse(call);
        const r = AgentToolResult.safeParse(result);
        return c.success && r.success ? [{ turnId: t.id, call: c.data, result: r.data }] : [];
      }),
    ),
  );
}

const ok = (c: Call) => c.result.status === 'ok';
const declined = (calls: Call[], what: string) => calls.some((c) => ok(c) && c.call.tool === 'record_decline' && c.call.what === what);

/** Required fields the profile questions fill: all but style (style selection) and the approver. */
export const missingFromQuestions = (profile: unknown) =>
  missingRequiredProfileFields((profile ?? {}) as Record<string, unknown>).filter((f) => f !== 'style' && f !== 'approverPhone');

/**
 * The done rules (agent.md, Agents): profile_questions when no required field is missing and the
 * closing "anything else?" was asked in an earlier turn (so this turn read its answer) or declined;
 * brand_assets when the logo and the business photos each came as an image or were declined;
 * profile_review when this turn saved a correction.
 */
export async function onboardingDone(db: Database, businessId: string, turnId: string): Promise<boolean> {
  const { profile, step, question } = await db.withBusiness('workflow', businessId, async (tx) => {
    const [business] = await tx.select({ profile: schema.business.profile }).from(schema.business).where(eq(schema.business.id, businessId));
    const [state] = await tx.select().from(schema.conversationState).where(eq(schema.conversationState.businessId, businessId));
    return { profile: business?.profile, step: state?.step, question: OpenQuestion.safeParse(state?.openQuestion) };
  });
  const calls = await onboardingCalls(db, businessId);

  switch (step) {
    case 'profile_questions': {
      if (missingFromQuestions(profile).length > 0) return false;
      const askedBefore = calls.some((c) => ok(c) && c.turnId !== turnId && c.call.tool === 'ask_owner' && c.call.topic === 'anything_else' && c.call.expects === 'answer');
      return askedBefore || declined(calls, 'anything_else');
    }
    case 'brand_assets': {
      const draft = BusinessProfileDraft.safeParse(profile);
      const logo = (draft.success && draft.data.brand?.logoAssetId) || declined(calls, 'logo');
      const photos = (question.success && question.data.photoAssetIds.length > 0) || declined(calls, 'business_photos');
      return Boolean(logo && photos);
    }
    case 'profile_review':
      return calls.some((c) => ok(c) && c.turnId === turnId && c.call.tool === 'set_profile_field');
    default:
      return false;
  }
}

export const onboardingAgent: AgentDefinition = {
  name: 'onboarding',
  task: 'agent_onboarding',
  tools: ['ask_owner', 'set_profile_field', 'request_photo', 'record_decline', 'hand_off_to_console', 'end_turn'],
  doneRule:
    'profile_questions: every required field (name, field, mainProducts, location, differentiator, channels) is set, and you asked "anything else customers should know?" once and read the answer, or the owner declined. ' +
    'brand_assets: the logo arrived as an image or the owner declined it, and business photos arrived or the owner declined them. ' +
    'profile_review: you saved the correction the owner asked for.',
  isDone: ({ db, businessId, turnId }) => onboardingDone(db, businessId, turnId),
};
