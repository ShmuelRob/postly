import { and, asc, eq, inArray } from 'drizzle-orm';
import { BusinessProfile } from '../../contracts/business-profile.js';
import type { Network } from '../../contracts/common.js';
import { OpenQuestion } from '../../contracts/open-question.js';
import type { SendTextRequest } from '../../contracts/providers/messaging.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import type { DraftsBurst } from './drafts.js';
import * as copy from './schedule-copy.js';
import type { Workflow } from './workflow.js';

// The time proposal and its confirmation (state-machines.md, Conversation; technical-design.md,
// Scheduling and publishing flow). The publishing module proposes the times and creates the
// publications; this file runs the conversation around them. No model is involved.

export const SCHEDULE_QUESTION = 'schedule_confirmation';

export interface ScheduleFlowDeps {
  db: Database;
  workflow: Pick<Workflow, 'apply' | 'startHandoff' | 'mayAutoReply'>;
  messaging: { sendText(businessId: string, request: SendTextRequest): Promise<unknown> };
  /** `proposeTimes` of the publishing module; throws `NoTimeAvailableError` when nothing fits. */
  propose(options: { count: number; rules: BusinessProfile['schedule']; timezone: string; city: string | undefined; now: Date }): Date[];
  /** `Scheduling.schedule`; throws `MissingChannelError` (with `networks`) when a channel is not verified. */
  schedule(businessId: string, postId: string, at: Date): Promise<unknown>;
  now?: () => Date;
}

export interface ScheduleFlow {
  /**
   * After an approval: when every post of the week is approved or cancelled, proposes the times
   * (`ALL_DRAFTS_RESOLVED`). Returns true when it sent the proposal.
   */
  afterApproval(businessId: string, postId: string): Promise<boolean>;
  /** A burst in `confirming_schedule`; false for any other step. */
  handle(burst: DraftsBurst): Promise<boolean>;
}

const FILLERS = ['תודה', 'מעולה', 'טוב', 'הכל', 'הכול', 'לגמרי', 'בסדר', 'נשמע', 'אחלה'];

/** True when the text only accepts the times: confirming words, optionally with fillers. */
export function isScheduleConfirmation(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .split(/[\s.,!?;:׳״"'()-]+/u)
    .filter((t) => t.length > 0);
  return tokens.some((t) => copy.SCHEDULE_CONFIRM_WORDS.includes(t)) && tokens.every((t) => copy.SCHEDULE_CONFIRM_WORDS.includes(t) || FILLERS.includes(t));
}

const isMissingChannel = (error: unknown): error is Error & { networks: Network[] } =>
  error instanceof Error && error.name === 'MissingChannelError' && Array.isArray((error as { networks?: unknown }).networks);

export function createScheduleFlow(deps: ScheduleFlowDeps): ScheduleFlow {
  const { db, workflow } = deps;
  const now = deps.now ?? (() => new Date());

  const load = (businessId: string) =>
    db.withBusiness('workflow', businessId, async (tx) => {
      const [business] = await tx.select().from(schema.business).where(eq(schema.business.id, businessId));
      const [state] = await tx.select().from(schema.conversationState).where(eq(schema.conversationState.businessId, businessId));
      if (!business || !state) return undefined;
      const question = state.openQuestion ? OpenQuestion.safeParse(state.openQuestion) : undefined;
      return { business, step: state.step, question: question?.success ? question.data : undefined };
    });

  const topics = (businessId: string, postIds: string[]) =>
    db.withBusiness('workflow', businessId, async (tx) => {
      const rows = postIds.length ? await tx.select({ id: schema.post.id, plan: schema.post.plan }).from(schema.post).where(inArray(schema.post.id, postIds)) : [];
      return new Map(rows.map((r) => [r.id, (r.plan as { topic?: string }).topic ?? '']));
    });

  async function handOff(businessId: string, to: string, text: string, details: Record<string, unknown>) {
    await workflow.startHandoff(businessId, { step: 'confirming_schedule', ...details });
    await deps.messaging.sendText(businessId, { to, text });
  }

  async function confirm(burst: DraftsBurst, proposals: { postId: string; at: string }[], timezone: string) {
    const statuses = await db.withBusiness('workflow', burst.businessId, async (tx) =>
      proposals.length
        ? tx.select({ id: schema.post.id, status: schema.post.status }).from(schema.post).where(inArray(schema.post.id, proposals.map((p) => p.postId)))
        : [],
    );
    const done: { postId: string; at: string }[] = [];
    const missing = new Set<Network>();
    for (const proposal of proposals) {
      // A post changed or cancelled since the proposal is not scheduled; a changed one gets its own proposal later.
      if (statuses.find((s) => s.id === proposal.postId)?.status !== 'approved') continue;
      try {
        await deps.schedule(burst.businessId, proposal.postId, new Date(proposal.at));
        done.push(proposal);
      } catch (error) {
        if (!isMissingChannel(error)) throw error;
        for (const n of error.networks) missing.add(n);
      }
    }
    const names = await topics(burst.businessId, done.map((d) => d.postId));
    const items = done.map((d) => ({ topic: names.get(d.postId) ?? '', at: copy.when(new Date(d.at), timezone) }));
    if (missing.size > 0) {
      const networks = [...missing];
      await db.withBusiness('workflow', burst.businessId, (tx) =>
        tx.insert(schema.consoleItem).values({ businessId: burst.businessId, kind: 'channel_disconnected', details: { networks, reason: 'scheduling found no verified connection' } }),
      );
      if (items.length > 0) await deps.messaging.sendText(burst.businessId, { to: burst.from, text: copy.scheduled(items) });
      return handOff(burst.businessId, burst.from, copy.channelMissing(networks), { reason: 'channel missing at scheduling', networks });
    }
    await workflow.apply(burst.businessId, {
      machine: 'conversation',
      id: burst.businessId,
      event: 'SCHEDULE_CONFIRMED',
      source: 'inbound',
      guard: async (tx) => {
        await tx.update(schema.conversationState).set({ openQuestion: null }).where(eq(schema.conversationState.businessId, burst.businessId));
        return null;
      },
    });
    await deps.messaging.sendText(burst.businessId, { to: burst.from, text: copy.scheduled(items) });
  }

  return {
    async afterApproval(businessId, postId) {
      const loaded = await load(businessId);
      if (!loaded || loaded.step !== 'reviewing_drafts' || loaded.business.status !== 'active') return false;
      const posts = await db.withBusiness('workflow', businessId, async (tx) => {
        const [post] = await tx.select({ weekId: schema.post.weeklyUpdateId }).from(schema.post).where(eq(schema.post.id, postId));
        if (!post) return [];
        return tx
          .select({ id: schema.post.id, status: schema.post.status, plan: schema.post.plan })
          .from(schema.post)
          .where(and(eq(schema.post.weeklyUpdateId, post.weekId), eq(schema.post.businessId, businessId)))
          .orderBy(asc(schema.post.position));
      });
      if (posts.some((p) => p.status !== 'approved' && p.status !== 'cancelled')) return false;
      const approved = posts.filter((p) => p.status === 'approved');
      if (approved.length === 0) return false;

      const profile = BusinessProfile.parse(loaded.business.profile);
      const timezone = loaded.business.timezone;
      let times: Date[];
      try {
        times = deps.propose({ count: approved.length, rules: profile.schedule, timezone, city: profile.location.city, now: now() });
      } catch (error) {
        if ((error as Error).name !== 'NoTimeAvailableError') throw error;
        await handOff(businessId, loaded.business.approverPhone, copy.noTimeFits, { reason: 'no publishing time fits the profile' });
        return true;
      }
      const proposals = approved.map((p, i) => ({ postId: p.id, at: times[i]!.toISOString() }));
      const question: OpenQuestion = { key: SCHEDULE_QUESTION, askedFields: [], attempts: 1, photoAssetIds: [], proposals };
      const result = await workflow.apply(businessId, {
        machine: 'conversation',
        id: businessId,
        event: 'ALL_DRAFTS_RESOLVED',
        source: 'system',
        guard: async (tx) => {
          await tx.update(schema.conversationState).set({ openQuestion: question }).where(eq(schema.conversationState.businessId, businessId));
          return null;
        },
      });
      if (!result.ok) return false;
      const items = approved.map((p, i) => ({ topic: (p.plan as { topic?: string }).topic ?? '', at: copy.when(times[i]!, timezone) }));
      await deps.messaging.sendText(businessId, { to: loaded.business.approverPhone, text: copy.proposal(items) });
      return true;
    },

    async handle(burst) {
      const loaded = await load(burst.businessId);
      if (!loaded || loaded.step !== 'confirming_schedule' || loaded.business.status !== 'active') return false;
      if (burst.from !== loaded.business.approverPhone || !(await workflow.mayAutoReply(burst.businessId))) return true;
      // A Change tap reopens the drafts (CHANGE_REQUESTED, then DRAFTS_SENT back to reviewing_drafts,
      // dropping the proposal) and goes on to drafts; after the new version is approved, times are proposed again.
      const [only] = burst.messages;
      if (burst.messages.length === 1 && only?.content.kind === 'button_reply' && (only.content.payload as { action?: string } | undefined)?.action === 'change') {
        const reopened = await workflow.apply(burst.businessId, {
          machine: 'conversation',
          id: burst.businessId,
          event: 'CHANGE_REQUESTED',
          source: 'inbound',
          guard: async (tx) => {
            await tx.update(schema.conversationState).set({ openQuestion: null }).where(eq(schema.conversationState.businessId, burst.businessId));
            return null;
          },
        });
        if (reopened.ok) await workflow.apply(burst.businessId, { machine: 'conversation', id: burst.businessId, event: 'DRAFTS_SENT', source: 'inbound' });
        return false;
      }
      const proposals = loaded.question?.key === SCHEDULE_QUESTION ? (loaded.question.proposals ?? []) : [];
      const textOnly = burst.messages.every((m) => m.content.kind === 'text');
      if (textOnly && proposals.length > 0 && isScheduleConfirmation(burst.text)) {
        await confirm(burst, proposals, loaded.business.timezone);
        return true;
      }
      // Phase 1: a person sets other times (reading requested times from text is a follow-up).
      await handOff(burst.businessId, burst.from, copy.scheduleChangeHandedOff, { reason: 'schedule change requested', text: burst.text });
      return true;
    },
  };
}
