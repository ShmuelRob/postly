import { and, eq } from 'drizzle-orm';
import { BusinessProfile } from '../../contracts/business-profile.js';
import type { ModelTaskInput, ModelTaskName, ModelTaskOutput } from '../../contracts/model-tasks.js';
import type { SendTemplateRequest, SendTextRequest } from '../../contracts/providers/messaging.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { checkPlan, checkQuotes } from '../content/index.js';
import type { OnboardingBurst } from './onboarding.js';
import { localWeek } from './week.js';
import * as copy from './weekly-copy.js';
import type { Workflow } from './workflow.js';

// The weekly update (PRD, "Weekly update and content preparation" and "A week without an update";
// technical-design.md, Weekly update flow; state-machines.md, Weekly update). Code owns the week;
// models only transcribe, detect intent, extract facts, and plan, each output checked in code.

export interface WeeklyDeps {
  db: Database;
  workflow: Workflow;
  messaging: {
    sendText(businessId: string, request: SendTextRequest): Promise<unknown>;
    sendTemplate(businessId: string, request: SendTemplateRequest): Promise<unknown>;
  };
  model: {
    run<T extends ModelTaskName>(
      businessId: string,
      task: T,
      input: ModelTaskInput<T>,
      options?: { referenceId?: string; check?: (output: ModelTaskOutput<T>) => string | null },
    ): Promise<ModelTaskOutput<T>>;
  };
  now?: () => Date;
  /** Runs once the week's plan is stored: drafting (technical-design.md, Drafts flow). */
  afterPlan?(businessId: string, weekId: string): Promise<void>;
}

export interface WeeklyUpdates {
  /** The hourly scheduler job: `tickBusiness` for every active business. */
  tick(now: Date): Promise<void>;
  /** Does what is due for one business: create the week row, send the reminder, end the week. Idempotent. */
  tickBusiness(businessId: string, now: Date): Promise<void>;
  /** Handles one burst of an active business whose conversation is idle; anything else is left alone. */
  handle(burst: OnboardingBurst): Promise<void>;
}

/** Monday 10:00 and Thursday 12:00, local (technical-design.md, Operational defaults). */
const REMINDER_AT = { day: 1, minutes: 10 * 60 };
const CUTOFF_AT = { day: 4, minutes: 12 * 60 };
const reached = (w: { day: number; minutes: number }, t: { day: number; minutes: number }) =>
  w.day > t.day || (w.day === t.day && w.minutes >= t.minutes);

export function createWeeklyUpdates(deps: WeeklyDeps): WeeklyUpdates {
  const { db, workflow } = deps;
  const now = deps.now ?? (() => new Date());
  /** Weeks whose plan was just stored and that drafting picks up next. */
  const pendingDrafts = new Map<string, string>();

  const loadBusiness = (businessId: string) =>
    db.withBusiness('workflow', businessId, async (tx) => {
      const [business] = await tx.select().from(schema.business).where(eq(schema.business.id, businessId));
      const [state] = await tx.select().from(schema.conversationState).where(eq(schema.conversationState.businessId, businessId));
      return business && state ? { business, step: state.step } : undefined;
    });

  /** The week row, created `awaiting` if missing; an existing row is kept as it is. */
  const weekRow = (businessId: string, weekStart: string) =>
    db.withBusiness('workflow', businessId, async (tx) => {
      const t = schema.weeklyUpdate;
      await tx.insert(t).values({ businessId, weekStart }).onConflictDoNothing({ target: [t.businessId, t.weekStart] });
      const [row] = await tx.select().from(t).where(and(eq(t.businessId, businessId), eq(t.weekStart, weekStart)));
      if (!row) throw new Error(`weekly_update ${weekStart} missing after insert`);
      return row;
    });

  const weekEvent = (businessId: string, id: string, event: string, set?: Partial<typeof schema.weeklyUpdate.$inferInsert>, source: 'inbound' | 'system' = 'system') =>
    workflow.apply(businessId, {
      machine: 'weekly_update',
      id,
      event,
      source,
      ...(set
        ? {
            guard: async (tx) => {
              await tx.update(schema.weeklyUpdate).set({ ...set, updatedAt: new Date() }).where(eq(schema.weeklyUpdate.id, id));
              return null;
            },
          }
        : {}),
    });

  async function tickBusiness(businessId: string, at: Date) {
    const loaded = await loadBusiness(businessId);
    if (loaded?.business.status !== 'active') return;
    const { business } = loaded;
    const w = localWeek(at, business.timezone);
    const week = await weekRow(businessId, w.weekStart);

    const beforeCutoff = !reached(w, CUTOFF_AT);
    if (week.status === 'awaiting' && reached(w, REMINDER_AT) && beforeCutoff) {
      // REMINDER_SENT first, so a crash or a parallel tick never sends it twice (at most once).
      const marked = await weekEvent(businessId, week.id, 'REMINDER_SENT', { reminderSentAt: at });
      if (!marked.ok) return;
      const profile = BusinessProfile.parse(business.profile);
      try {
        await deps.messaging.sendTemplate(businessId, {
          to: business.approverPhone,
          templateName: copy.REMINDER_TEMPLATE,
          language: profile.languages[0] ?? 'he',
          variables: { businessName: business.name },
        });
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', msg: 'weekly reminder not sent', businessId, weekId: week.id, error: String(error) }));
      }
      return;
    }
    // The cutoff closes a week that got no update, reminded or not.
    if ((week.status === 'reminded' || week.status === 'awaiting') && !beforeCutoff) await weekEvent(businessId, week.id, 'WEEK_ENDED');
  }

  /** The owner's typed text and the transcripts of the burst's voice notes. */
  async function readBurst(burst: OnboardingBurst, language: string) {
    const transcripts: string[] = [];
    for (const m of burst.messages) {
      if (m.content.kind !== 'voice') continue;
      for (const voiceAssetId of m.mediaAssetIds) {
        const t = await deps.model.run(burst.businessId, 'transcription', { voiceAssetId, languageHint: language as 'he' });
        if (t.text.trim()) transcripts.push(t.text.trim());
      }
    }
    const photos = burst.messages.filter((m) => m.content.kind === 'image').flatMap((m) => m.mediaAssetIds);
    return { text: burst.text.trim(), transcript: transcripts.join('\n'), photos, hadVoice: burst.messages.some((m) => m.content.kind === 'voice') };
  }

  async function handle(burst: OnboardingBurst) {
    const { businessId } = burst;
    const loaded = await loadBusiness(businessId);
    const busy = loaded?.step === 'processing_update';
    if (!loaded || loaded.business.status !== 'active' || (loaded.step !== 'idle' && !busy)) return;
    const { business } = loaded;
    // state-machines.md, Conversation: an update is accepted only from the approver number.
    if (burst.from !== business.approverPhone) return;
    if (!(await workflow.mayAutoReply(businessId))) return;
    const profile = BusinessProfile.parse(business.profile);
    const reply = (text: string) => deps.messaging.sendText(businessId, { to: burst.from, text });

    let recognized = false;
    try {
      const update = await readBurst(burst, profile.languages[0] ?? 'he');
      const isUpdate =
        update.photos.length > 0 ||
        update.hadVoice ||
        (update.text !== '' &&
          (await deps.model.run(businessId, 'intent_detection', { text: update.text, step: loaded.step, draftsOpen: false })).intent === 'weekly_update');
      if (!isUpdate) return;
      recognized = true;
      // A second update while the last one is still being drafted is not applied (technical-design.md).
      if (busy) return void (await reply(copy.stillWorking));

      // Which week: the current one while open; after the cutoff, or once this week's update is in,
      // next week's row, opened early.
      const w = localWeek(now(), business.timezone);
      let week = await weekRow(businessId, w.weekStart);
      const late = week.status !== 'awaiting' && week.status !== 'reminded';
      if (late) week = await weekRow(businessId, w.nextWeekStart);
      if (week.status !== 'awaiting' && week.status !== 'reminded') return void (await reply(copy.nextWeekAlreadyIn));

      const received = await weekEvent(
        businessId,
        week.id,
        'UPDATE_RECEIVED',
        { originalText: update.text || null, transcript: update.transcript || null, mediaAssetIds: update.photos, receivedAt: now() },
        'inbound',
      );
      if (!received.ok) return;
      await plan(burst, week.id, profile, update, late);
      if (pendingDrafts.delete(week.id)) await deps.afterPlan?.(businessId, week.id);
    } catch (error) {
      // A model task that failed every attempt is already a console item; a person takes over.
      // Before the update was recognized, the owner gets a neutral line, not "update received".
      if (error instanceof Error && error.name === 'ModelTaskFailedError') {
        await workflow.startHandoff(businessId, { reason: error.message, step: 'weekly_update' });
        return void (await reply(recognized ? copy.updateNeedsReview : copy.handoffNeutral));
      }
      throw error;
    }
  }

  async function plan(burst: OnboardingBurst, weekId: string, profile: BusinessProfile, update: Awaited<ReturnType<typeof readBurst>>, late: boolean) {
    const { businessId } = burst;
    const reply = (text: string) => deps.messaging.sendText(businessId, { to: burst.from, text });
    try {
      await extractAndPlan(burst, weekId, profile, update, late);
    } catch (error) {
      // Anything else that stops the plan: the week goes to the console instead of staying `received`.
      console.error(JSON.stringify({ level: 'error', msg: 'weekly plan failed', businessId, weekId, error: String(error) }));
      await db.withBusiness('workflow', businessId, (tx) =>
        tx.insert(schema.consoleItem).values({ businessId, kind: 'extraction_failed', referenceId: weekId, details: { error: String(error) } }),
      );
      await weekEvent(businessId, weekId, 'EXTRACTION_FAILED');
      await reply(copy.updateNeedsReview);
    }
  }

  async function extractAndPlan(burst: OnboardingBurst, weekId: string, profile: BusinessProfile, update: Awaited<ReturnType<typeof readBurst>>, late: boolean) {
    const { businessId } = burst;
    const reply = (text: string) => deps.messaging.sendText(businessId, { to: burst.from, text });
    let facts: ModelTaskOutput<'fact_extraction'>;
    let planned: ModelTaskOutput<'weekly_planning'>;
    try {
      const source = { text: update.text, ...(update.transcript ? { transcript: update.transcript } : {}) };
      facts = await deps.model.run(
        businessId,
        'fact_extraction',
        { ...source, profileSummary: profileSummary(profile) },
        { referenceId: weekId, check: (output) => checkQuotes(output, source) },
      );
      const context = { facts: facts.facts, postsPerWeek: profile.postsPerWeek, formats: profile.formats, mediaAssetIds: update.photos };
      planned = await deps.model.run(
        businessId,
        'weekly_planning',
        { ...context, contentTypes: profile.contentTypes, formats: profile.formats, mediaAssetIds: update.photos },
        { referenceId: weekId, check: (output) => checkPlan(output.posts, context) },
      );
    } catch (error) {
      if (!(error instanceof Error && error.name === 'ModelTaskFailedError')) throw error;
      await weekEvent(businessId, weekId, 'EXTRACTION_FAILED');
      return reply(copy.updateNeedsReview);
    }

    // FACTS_EXTRACTED stores the plan: the facts and one post per planned post, in one transaction.
    const stored = await workflow.apply(businessId, {
      machine: 'weekly_update',
      id: weekId,
      event: 'FACTS_EXTRACTED',
      source: 'system',
      guard: async (tx) => {
        await tx.update(schema.weeklyUpdate).set({ extractedFacts: facts, updatedAt: new Date() }).where(eq(schema.weeklyUpdate.id, weekId));
        await tx
          .insert(schema.post)
          .values(planned.posts.map((p, position) => ({ businessId, weeklyUpdateId: weekId, position, format: p.format, plan: p })));
        return null;
      },
    });
    if (!stored.ok) return;
    await workflow.apply(businessId, { machine: 'conversation', id: businessId, event: 'UPDATE_RECEIVED', source: 'inbound' });
    await reply(late ? copy.updateForNextWeek(planned.posts.length) : copy.updateReceived(planned.posts.length));
    // Drafting is outside the plan's error handling: a draft failure never moves the week back.
    pendingDrafts.set(weekId, businessId);
  }

  return {
    async tick(at) {
      const due = await db.withSystem('scheduler', (tx) =>
        tx.select({ id: schema.business.id }).from(schema.business).where(eq(schema.business.status, 'active')),
      );
      for (const { id } of due) {
        try {
          await tickBusiness(id, at);
        } catch (error) {
          // One business failing does not stop the others; the next tick tries again.
          console.error(JSON.stringify({ level: 'error', msg: 'weekly tick failed', businessId: id, error: String(error) }));
        }
      }
    },
    tickBusiness,
    handle,
  };
}

/** The short profile context fact_extraction gets. */
function profileSummary(profile: BusinessProfile): string {
  return `${profile.name}, ${profile.field}. מוצרים: ${profile.mainProducts.join(', ')}. ${profile.location.address}, ${profile.location.city}.`;
}
