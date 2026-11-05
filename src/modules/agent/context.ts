import { and, desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import {
  AGENT_PERSONA_GENDER,
  AgentContext,
  type AgentName,
  type AgentToolName,
  type AgentToolResult,
  DEFAULT_AGENT_NAME,
  personaName,
} from '../../contracts/agent.js';
import { BusinessProfileDraft, missingRequiredProfileFields } from '../../contracts/business-profile.js';
import { Fact, PlannedPost } from '../../contracts/content.js';
import { OpenQuestion } from '../../contracts/open-question.js';
import type { Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import type { AgentDefinition, PastCall } from './types.js';

/** The model sees the last 20 messages within 14 days (agent.md, A10). */
export const CONTEXT_MESSAGES = 20;
export const CONTEXT_DAYS = 14;
const HISTORY_TOPICS = 8;

const AgentNames = z.partialRecord(z.enum(['he', 'en', 'ar', 'ru']), z.string().min(1));

export interface ContextInput {
  businessId: string;
  agent: AgentDefinition;
  now: Date;
  history: PastCall[];
  budget: { stepsLeft: number; costLeftUsd: number };
  toolResults: { tool: AgentToolName; result: AgentToolResult }[];
}

export interface BuiltContext {
  context: AgentContext;
  approverPhone: string;
  timezone: string;
  personaName: string;
}

/** Builds the agent's input from one business only, as the workflow role (agent.md, Context). */
export async function buildContext(tx: Tx, input: ContextInput): Promise<BuiltContext> {
  const { businessId, agent, now } = input;
  const [business] = await tx.select().from(schema.business).where(eq(schema.business.id, businessId));
  if (!business) throw new Error('business not found');
  const [conversation] = await tx.select().from(schema.conversationState).where(eq(schema.conversationState.businessId, businessId));
  if (!conversation) throw new Error('conversation_state not found');
  const [control] = await tx.select({ agentName: schema.systemControl.agentName }).from(schema.systemControl);

  // The approver's number never reaches the model (agent.md, Context).
  const { approverPhone: _approver, ...rawProfile } = (business.profile ?? {}) as Record<string, unknown>;
  const parsedProfile = AgentContext.shape.profile.safeParse(rawProfile);
  const profile = parsedProfile.success ? parsedProfile.data : {};
  const draft = BusinessProfileDraft.safeParse(rawProfile);
  const languages = (draft.success && draft.data.languages) || ['he'];
  const tone = (draft.success && draft.data.tone) || { register: 'warm' as const, address: 'plural' as const, emoji: true };
  const globalNames = AgentNames.safeParse(control?.agentName);
  const name = personaName(profile, languages[0]!, globalNames.success ? globalNames.data : DEFAULT_AGENT_NAME);

  const since = new Date(now.getTime() - CONTEXT_DAYS * 86_400_000);
  const rows = await tx
    .select()
    .from(schema.message)
    .where(and(eq(schema.message.businessId, businessId), gte(schema.message.createdAt, since)))
    .orderBy(desc(schema.message.createdAt))
    .limit(CONTEXT_MESSAGES);
  const messages = rows.reverse().map((m) => ({
    role: m.direction === 'inbound' ? ('owner' as const) : ('postly' as const),
    text: m.body ?? '',
    at: m.createdAt.toISOString(),
    photos: m.mediaAssetIds.map((assetId) => ({ assetId })),
  }));

  // The current week: the newest weekly_update row (weekly and drafts agents).
  let week: AgentContext['week'] = null;
  let posts: AgentContext['posts'] = [];
  if (agent.name !== 'onboarding') {
    const [row] = await tx
      .select()
      .from(schema.weeklyUpdate)
      .where(eq(schema.weeklyUpdate.businessId, businessId))
      .orderBy(desc(schema.weeklyUpdate.weekStart))
      .limit(1);
    if (row) {
      const facts = z.object({ facts: z.array(Fact) }).safeParse(row.extractedFacts);
      week = {
        ...(row.originalText ? { updateText: row.originalText } : {}),
        ...(row.transcript ? { transcript: row.transcript } : {}),
        facts: facts.success ? facts.data.facts : [],
        declines: declines(input.history),
      };
      const postRows = await tx
        .select()
        .from(schema.post)
        .where(and(eq(schema.post.businessId, businessId), eq(schema.post.weeklyUpdateId, row.id)))
        .orderBy(schema.post.position);
      posts = postRows.flatMap((p) => {
        const plan = PlannedPost.safeParse(p.plan);
        return plan.success ? [{ id: p.id, state: p.status, format: p.format, plan: plan.data }] : [];
      });
    }
  }

  const topics = await tx
    .select({ plan: schema.post.plan })
    .from(schema.post)
    .where(eq(schema.post.businessId, businessId))
    .orderBy(desc(schema.post.createdAt))
    .limit(HISTORY_TOPICS);
  const openQuestion = OpenQuestion.safeParse(conversation.openQuestion);

  const context = AgentContext.parse({
    agent: agent.name,
    persona: { name, gender: AGENT_PERSONA_GENDER },
    languages,
    tone,
    profile,
    missingFields: missingRequiredProfileFields(rawProfile).filter((f) => f !== 'approverPhone'),
    messages,
    step: conversation.step,
    openQuestion: openQuestion.success ? openQuestion.data : null,
    week,
    posts,
    rules: [],
    history: topics.flatMap((t) => {
      const plan = PlannedPost.safeParse(t.plan);
      return plan.success ? [plan.data.topic] : [];
    }),
    tools: agent.tools,
    doneRule: agent.doneRule,
    budget: input.budget,
    toolResults: input.toolResults,
  });
  return { context, approverPhone: business.approverPhone, timezone: business.timezone, personaName: name };
}

/** What the owner declined, from earlier successful `record_decline` calls in scope. */
export function declines(history: PastCall[]): string[] {
  return history.flatMap((h) => (h.call.tool === 'record_decline' && h.result.status === 'ok' ? [h.call.what] : []));
}

export type { AgentName };
