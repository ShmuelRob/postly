import { and, desc, eq, gte, inArray } from 'drizzle-orm';
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
import { ChannelCaptions, Fact, PlannedPost } from '../../contracts/content.js';
import { DesignSpec, PhotoEdit } from '../../contracts/design-spec.js';
import { OpenQuestion } from '../../contracts/open-question.js';
import type { Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { toolsFor, type AgentDefinition, type PastCall } from './types.js';

/** The model sees the last 20 messages within 14 days (agent.md, A10). */
export const CONTEXT_MESSAGES = 20;
export const CONTEXT_DAYS = 14;
const HISTORY_TOPICS = 8;

/** The `image_review` notes of a photo as the agent reads them (media_asset.review, agent.md, Photos the agent sees). */
const PhotoReview = z.object({
  usable: z.boolean().optional(),
  description: z.string().optional(),
  crop: PhotoEdit.shape.crop,
  rotateDeg: PhotoEdit.shape.rotateDeg,
  brightness: PhotoEdit.shape.brightness,
  contrast: PhotoEdit.shape.contrast,
});

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
    // Equal timestamps (a fixed clock, or one second of messages) keep their arrival order.
    .orderBy(desc(schema.message.createdAt), desc(schema.message.seq))
    .limit(CONTEXT_MESSAGES);
  // The photo notes of every photo the agent can see: in these messages, or in this week's posts (below).
  const reviews = new Map<string, ReturnType<typeof notesOf>>();
  const loadNotes = async (ids: string[]) => {
    const missing = [...new Set(ids)].filter((id) => !reviews.has(id));
    if (missing.length === 0) return;
    const found = await tx.select({ id: schema.mediaAsset.id, review: schema.mediaAsset.review }).from(schema.mediaAsset).where(inArray(schema.mediaAsset.id, missing));
    for (const id of missing) reviews.set(id, notesOf(found.find((f) => f.id === id)?.review));
  };
  const photo = (assetId: string) => ({ assetId, ...reviews.get(assetId) });
  await loadNotes(rows.flatMap((m) => m.mediaAssetIds));
  const messages = rows.reverse().map((m) => ({
    role: m.direction === 'inbound' ? ('owner' as const) : ('postly' as const),
    text: m.body ?? '',
    at: m.createdAt.toISOString(),
    photos: m.mediaAssetIds.map(photo),
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
      // The current version of each post: its captions and design (agent.md, Context).
      const versionIds = postRows.flatMap((p) => (p.currentVersionId ? [p.currentVersionId] : []));
      const versions = versionIds.length ? await tx.select().from(schema.postVersion).where(inArray(schema.postVersion.id, versionIds)) : [];
      for (const p of postRows) await loadNotes(PlannedPost.safeParse(p.plan).data?.mediaAssetIds ?? []);
      posts = postRows.flatMap((p) => {
        const plan = PlannedPost.safeParse(p.plan);
        if (!plan.success) return [];
        const version = versions.find((v) => v.id === p.currentVersionId);
        const captions = ChannelCaptions.safeParse(version?.captions);
        const design = DesignSpec.safeParse(version?.designSpec);
        return [
          {
            id: p.id,
            state: p.status,
            format: p.format,
            plan: plan.data,
            ...(captions.success ? { captions: captions.data } : {}),
            ...(design.success ? { design: design.data } : {}),
            photos: plan.data.mediaAssetIds.map(photo),
          },
        ];
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
  const rules = await tx
    .select({ rule: schema.preferenceRule.rule })
    .from(schema.preferenceRule)
    .where(and(eq(schema.preferenceRule.businessId, businessId), eq(schema.preferenceRule.active, true)))
    .orderBy(schema.preferenceRule.createdAt);

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
    rules: rules.map((r) => r.rule),
    history: topics.flatMap((t) => {
      const plan = PlannedPost.safeParse(t.plan);
      return plan.success ? [plan.data.topic] : [];
    }),
    tools: toolsFor(agent, conversation.step),
    doneRule: agent.doneRule,
    budget: input.budget,
    toolResults: input.toolResults,
  });
  return { context, approverPhone: business.approverPhone, timezone: business.timezone, personaName: name };
}

/** The notes of a photo as the context carries them; nothing when it was not reviewed. */
function notesOf(review: unknown): { description?: string; usable?: boolean; suggested?: PhotoEdit } {
  const parsed = PhotoReview.safeParse(review);
  if (!parsed.success) return {};
  const { usable, description, ...edit } = parsed.data;
  const suggested = PhotoEdit.parse(Object.fromEntries(Object.entries(edit).filter(([, v]) => v !== undefined)));
  return {
    ...(description ? { description } : {}),
    ...(usable === undefined ? {} : { usable }),
    ...(Object.keys(suggested).length ? { suggested } : {}),
  };
}

/** What the owner declined, from earlier successful `record_decline` calls in scope. */
export function declines(history: PastCall[]): string[] {
  return history.flatMap((h) => (h.call.tool === 'record_decline' && h.result.status === 'ok' ? [h.call.what] : []));
}

export type { AgentName };
