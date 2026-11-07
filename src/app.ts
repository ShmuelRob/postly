import type { InboundMessage, MessagingProvider } from './contracts/providers/messaging.js';
import type { ModelProvider } from './contracts/providers/model.js';
import type { PaymentProvider, PaymentWebhooks } from './contracts/providers/payment.js';
import type { PublishingProvider } from './contracts/providers/publishing.js';
import { createBilling, type Billing } from './modules/billing/index.js';
import { createDataDeletion, type DataDeletion, type DeletionStorage } from './modules/business-data/index.js';
import type { TemplateRenderer } from './contracts/providers/renderer.js';
import type { Database } from './db/index.js';
import { type BusinessRenderContext, renderStyleSamples } from './modules/design/index.js';
import { type BurstWake, createMessaging, type MediaStorage, type Messaging, type Timers } from './modules/messaging/index.js';
import { createModelLayer } from './modules/model-layer/index.js';
import { type AgentDeps, createAgent } from './modules/agent/index.js';
import { and, eq } from 'drizzle-orm';
import { BusinessProfile } from './contracts/business-profile.js';
import * as schema from './db/schema.js';
import {
  createChannels,
  createMonthlyReport,
  createPublishingJob,
  previousMonth,
  createScheduling,
  proposeTimes,
  type Publishing,
  type PublishingNotice,
  type Scheduling,
  holidayInWeek,
} from './modules/publishing/index.js';
import {
  createApprovals,
  createCancellation,
  cancellationCopy,
  type Cancellation,
  createScheduleFlow,
  draftsCopy,
  scheduleCopy,
  type ScheduleFlow,
  type Approvals,
  createOnboarding,
  createDrafts,
  createWeeklyUpdates,
  type Drafts,
  createWorkflow,
  type Onboarding,
  type WeeklyUpdates,
  type Workflow,
  type WorkflowLogger,
} from './modules/workflow/index.js';
import { log } from './shared/logger.js';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

export interface AppOptions {
  db: Database;
  /** Called after every agent turn (the e2e report's agent steps, WP-91). */
  onAgentTurnEnd?: AgentDeps['onTurnEnd'];
  providers: {
    messaging: MessagingProvider;
    publishing: PublishingProvider;
    /** By the name `model_task_config.provider` uses, for example `google`. */
    models: Record<string, ModelProvider>;
    /** The payment provider; without it there is no billing, and cancellation skips the subscription. */
    payment?: PaymentProvider & PaymentWebhooks;
  };
  /** The design module's renderer factory (`createDesignRenderer(...).forBusiness`). */
  design: { forBusiness(business: BusinessRenderContext): TemplateRenderer };
  /** File storage for inbound media and renders, with the URLs providers fetch them from. */
  media: MediaStorage & { read(path: string): Promise<{ data: Uint8Array } | undefined> } & Partial<DeletionStorage>;
  /** From cancellation to data deletion (default 30 days, WP-43). */
  retentionMs?: number;
  businessNumber: string;
  /** The photo used for the onboarding style samples when the owner sent none. */
  samplePhotoUrl: string;
  burstQuietMs?: number;
  timers?: Timers;
  /** The burst wake-up; deployed, the pg-boss `inbound-burst` job (`jobBurstWake`), else in-process timers. */
  burstWake?: BurstWake;
  now?: () => Date;
  logger?: WorkflowLogger;
  /**
   * The one-shot onboarding, weekly and drafts flows instead of the agents (agent.md, A9). Off by
   * default: every composition runs the agents unless a test asks for the one-shot code, which is dead
   * in every deployed environment and goes with A9's cleanup. Only tests set it to `true` (the existing
   * end-to-end and H5 tests that drive those flows); no env variable, config field or Terraform value
   * reaches it (src/agents-always-on.test.ts).
   */
  oneShotFlows?: boolean;
}

export interface App {
  messaging: Messaging;
  workflow: Workflow;
  onboarding: Onboarding;
  /** The weekly update; its `tick` is the hourly scheduler job. */
  weekly: WeeklyUpdates;
  /** Drafts, change requests, and the several-photos choice (WP-32). */
  drafts: Drafts;
  /** The approval guard (WP-33): only the approver's Approve tap on the current version approves. */
  approvals: Approvals;
  /** Publications from a valid approval, at the confirmed times. */
  scheduling: Scheduling;
  /** The time proposal and its confirmation (WP-34). */
  schedule: ScheduleFlow;
  /** The publishing job behind the publishing guard; its `tick` is the worker's every-minute job (WP-34). */
  publishing: Publishing;
  /** The daily channel health check (WP-35); `businessId` limits it to one business (tests, playground). */
  channelHealth: { tick(now: Date, options?: { businessId?: string }): Promise<void> };
  /** Billing, when a payment provider is wired (WP-42); a provider `cancelled` cancels the business. */
  billing?: Billing;
  /** The daily billing-hold job (T16), when billing is wired; `businessId` limits it to one business. */
  billingHold?: { tick(now: Date, options?: { businessId?: string }): Promise<unknown> };
  /** Cancellation (WP-43): channels disconnected at once, then publications, posts and the subscription. */
  cancellation: Cancellation;
  /** The daily data deletion job (WP-43). */
  dataDeletion: DataDeletion;
  /** The monthly report job (WP-43): the previous month's figures, in each business's time zone, to every active business. */
  monthlyReport: { tick(now: Date, options?: { businessId?: string }): Promise<{ sent: string[] }> };
  /**
   * Starts background work of the process that receives webhooks: the sweep of inbound messages
   * never processed (review queue item 14), at startup and then every quiet window. Every handover
   * goes through the message claim, so it may run on several web instances. Returns a stop function.
   */
  start(): () => void;
}

/**
 * The composition root for the product flows: messaging hands each burst to the workflow, which
 * runs onboarding for a business in `onboarding` and the weekly update for an active one.
 */
export function createApp(options: AppOptions): App {
  const { db, providers } = options;
  const workflow = createWorkflow(db, options.logger);
  let onboarding: Onboarding | undefined;
  let weekly: WeeklyUpdates | undefined;
  let drafts: Drafts | undefined;
  let approvals: Approvals | undefined;

  const messaging = createMessaging({
    db,
    provider: providers.messaging,
    businessNumber: options.businessNumber,
    media: options.media,
    handler: {
      // Each flow ignores a business outside its status. The weekly flow runs first, so a burst that
      // completes onboarding is not read again as a weekly update.
      async handleInbound(burst) {
        if (await approve(burst)) return;
        if (await schedule.handle(burst)) return;
        if (await drafts!.handle(burst)) return;
        await weekly!.handle(burst);
        await onboarding!.handle(burst);
      },
    },
    ...(options.burstQuietMs !== undefined ? { burstQuietMs: options.burstQuietMs } : {}),
    ...(options.timers ? { timers: options.timers } : {}),
    ...(options.burstWake ? { wake: options.burstWake } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const model = createModelLayer({ db, providers: providers.models, resolveMediaUrl: (b, a) => messaging.mediaUrl(b, a) });
  // The hybrid agent (agent.md): onboarding, weekly and drafts always run on it, except where a test
  // composes the one-shot flows (`oneShotFlows`). Each flow stores the questions its agent asks.
  const oneShot = options.oneShotFlows ?? false;
  const agent = createAgent({
    db,
    models: model,
    messaging,
    events: {
      async questionAsked(businessId, question) {
        if (question.agent === 'onboarding') await onboarding!.agentAsked(businessId, question);
        if (question.agent === 'drafts') await drafts!.agentAsked(businessId, question);
      },
      draftCreated: (businessId, input) => drafts!.agentDraft(businessId, input),
      changeApplied: (businessId, input) => drafts!.agentChange(businessId, input),
      holidayInWeek: (businessId, postId) => drafts!.holidayInWeek(businessId, postId),
    },
    ...(options.onAgentTurnEnd ? { onTurnEnd: options.onAgentTurnEnd } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const scheduling = createScheduling({ db, apply: (b, r) => workflow.apply(b, r), ...(options.now ? { now: options.now } : {}) });
  approvals = createApprovals({
    db,
    workflow,
    mayAutoReply: (b) => workflow.mayAutoReply(b),
    recordInbound: (b, m) => messaging.record(b, m),
    cancelPendingPublications: (b, p) => scheduling.cancelPending(b, p),
    ...(options.now ? { now: options.now } : {}),
  });

  /**
   * An Approve tap, from any conversation step, goes to the approval service before any other flow
   * (technical-design.md, Approval flow). Returns false for every other burst.
   */
  async function approve(burst: Parameters<Drafts['handle']>[0]): Promise<boolean> {
    const [tap] = burst.messages;
    if (burst.messages.length !== 1 || tap?.content.kind !== 'button_reply') return false;
    const content = tap.content as unknown as Extract<InboundMessage['content'], { kind: 'button_reply' }>;
    if (content.payload.action !== 'approve') return false;
    const decision = await approvals!.handleStoredTap(burst.businessId, { messageId: tap.id, from: burst.from, content });
    if (decision.outcome === 'approved') {
      const topic = await drafts!.topicOf(burst.businessId, content.payload.postId);
      await messaging.sendText(burst.businessId, { to: burst.from, text: draftsCopy.approved(topic ?? '') });
      await schedule.afterApproval(burst.businessId, content.payload.postId);
    } else if (decision.reason === 'stale_version' || decision.reason === 'wrong_state' || decision.reason === 'unknown_post') {
      await drafts!.resendOpen(burst.businessId, burst.from, draftsCopy.notCurrentDraft);
    }
    return true;
  }

  const schedule = createScheduleFlow({
    db,
    workflow,
    messaging,
    propose: proposeTimes,
    schedule: (b, p, at) => scheduling.schedule(b, p, at),
    ...(options.now ? { now: options.now } : {}),
  });

  /** The owner's template when a post's publications are done (technical-design.md, Scheduling and publishing flow). */
  async function notify(businessId: string, notice: PublishingNotice) {
    const row = await db.withBusiness('workflow', businessId, async (tx) => {
      const [business] = await tx.select().from(schema.business).where(eq(schema.business.id, businessId));
      const [post] = await tx.select({ plan: schema.post.plan }).from(schema.post).where(eq(schema.post.id, notice.postId));
      return business && { phone: business.approverPhone, profile: BusinessProfile.safeParse(business.profile), topic: (post?.plan as { topic?: string } | undefined)?.topic ?? '' };
    });
    if (!row) return;
    const language = row.profile.success ? row.profile.data.languages[0]! : 'he';
    await messaging.sendTemplate(businessId, {
      to: row.phone,
      language,
      ...(notice.kind === 'published'
        ? { templateName: scheduleCopy.PUBLISHED_TEMPLATE, variables: { topic: row.topic, networks: scheduleCopy.networks(notice.networks) } }
        : { templateName: scheduleCopy.FAILED_TEMPLATE, variables: { topic: row.topic, failed: scheduleCopy.networks(notice.failed) } }),
    });
  }

  const publishing = createPublishingJob({
    db,
    provider: providers.publishing,
    apply: (b, r) => workflow.apply(b, r),
    mayAutoReply: (b) => workflow.mayAutoReply(b),
    urlFor: (path) => options.media.urlFor(path),
    notify,
    ...(options.now ? { now: options.now } : {}),
  });

  const channels = createChannels({ db, provider: providers.publishing, apply: (b, r) => workflow.apply(b, r), ...(options.now ? { now: options.now } : {}) });

  /** Every active business's verified channels; a lost one gets the owner's template (technical-design.md, Failure handling). */
  const channelHealth: App['channelHealth'] = {
    async tick(_now, tickOptions = {}) {
      const active = await db.withSystem('scheduler', (tx) =>
        tx
          .select({ id: schema.business.id })
          .from(schema.business)
          .where(and(eq(schema.business.status, 'active'), tickOptions.businessId ? eq(schema.business.id, tickOptions.businessId) : undefined)),
      );
      for (const { id } of active) {
        try {
          const lost = await channels.healthCheck(id);
          if (lost.length === 0) continue;
          const row = await db.withBusiness('workflow', id, async (tx) => (await tx.select().from(schema.business).where(eq(schema.business.id, id)))[0]);
          if (!row) continue;
          const profile = BusinessProfile.safeParse(row.profile);
          await messaging.sendTemplate(id, {
            to: row.approverPhone,
            language: profile.success ? profile.data.languages[0]! : 'he',
            templateName: scheduleCopy.CHANNEL_DISCONNECTED_TEMPLATE,
            variables: { networks: scheduleCopy.networks(lost) },
          });
        } catch (error) {
          log.error('channel health check failed', { businessId: id, error: errorText(error) });
        }
      }
    },
  };

  /** The owner's language and number, for a template. */
  async function owner(businessId: string) {
    const row = await db.withBusiness('workflow', businessId, async (tx) => (await tx.select().from(schema.business).where(eq(schema.business.id, businessId)))[0]);
    if (!row) return undefined;
    const profile = BusinessProfile.safeParse(row.profile);
    return { phone: row.approverPhone, language: profile.success ? profile.data.languages[0]! : 'he' };
  }

  let cancellation: Cancellation | undefined;
  const billing = providers.payment
    ? createBilling({
        db,
        messaging,
        provider: providers.payment,
        onCancelled: async (b) => void (await cancellation!.cancel(b, 'payment_provider')),
        // The billing hold (T16) goes through the existing business pause, not a path of its own.
        pauseBusiness: async (b) => (await workflow.apply(b, { machine: 'business', id: b, event: 'PAUSE', source: 'system' })).ok,
        resumeBusiness: async (b) => (await workflow.apply(b, { machine: 'business', id: b, event: 'RESUME', source: 'system' })).ok,
        ...(options.now ? { now: options.now } : {}),
      })
    : undefined;
  cancellation = createCancellation({
    db,
    workflow,
    revokeChannels: (b) => channels.revokeAll(b),
    cancelPublications: (b) => scheduling.cancelAllPending(b),
    ...(billing ? { cancelSubscription: (b: string) => billing.cancel(b) } : {}),
    messaging,
    ...(options.retentionMs !== undefined ? { retentionMs: options.retentionMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  const { removePrefix, remove } = options.media;
  const dataDeletion = createDataDeletion({
    db,
    ...(removePrefix && remove ? { storage: { removePrefix: (p: string) => removePrefix.call(options.media, p), remove: (p: string[]) => remove.call(options.media, p) } } : {}),
  });

  const report = createMonthlyReport({ db, provider: providers.publishing });
  const monthlyReport: App['monthlyReport'] = {
    async tick(at, tickOptions = {}) {
      const active = await db.withSystem('scheduler', (tx) =>
        tx
          .select({ id: schema.business.id, timezone: schema.business.timezone })
          .from(schema.business)
          .where(and(eq(schema.business.status, 'active'), tickOptions.businessId ? eq(schema.business.id, tickOptions.businessId) : undefined)),
      );
      const sent: string[] = [];
      for (const { id, timezone } of active) {
        try {
          const { from, to } = previousMonth(at, timezone);
          const figures = await report.figures(id, from, to);
          const to_ = figures && (await owner(id));
          if (!figures || !to_) continue;
          await messaging.sendTemplate(id, {
            to: to_.phone,
            language: to_.language,
            templateName: cancellationCopy.MONTHLY_REPORT_TEMPLATE,
            variables: {
              month: cancellationCopy.monthName(from, timezone),
              posts: String(figures.posts),
              reach: cancellationCopy.metric(figures.reach),
              engagement: cancellationCopy.metric(figures.engagement),
            },
          });
          sent.push(id);
        } catch (error) {
          log.error('monthly report failed', { businessId: id, error: errorText(error) });
        }
      }
      return { sent };
    },
  };

  onboarding = createOnboarding({
    db,
    workflow,
    ...(oneShot ? {} : { agent }),
    messaging,
    model,
    mediaUrl: (b, a) => messaging.mediaUrl(b, a),
    channels,
    samplePhotoUrl: options.samplePhotoUrl,
    ...(billing ? { sendPaymentLink: (b: string) => billing.sendPaymentLink(b) } : {}),
    async renderSamples({ businessId, businessName, ...sample }) {
      const renderer = options.design.forBusiness({ businessName, languages: ['he'], storagePrefix: `${businessId}/samples` });
      const samples = await renderStyleSamples(renderer, { ...sample, overlayText: businessName });
      return samples.map((s) => ({ style: s.style, url: options.media.urlFor(s.storagePath) }));
    },
  });

  drafts = createDrafts({
    db,
    workflow,
    ...(oneShot ? {} : { agent }),
    holidayInWeek,
    messaging,
    model,
    render: ({ businessId, businessName, languages }, request) =>
      options.design.forBusiness({ businessName, languages, storagePrefix: `${businessId}/posts` }).render(request),
    mediaUrl: (b, a) => messaging.mediaUrl(b, a),
    urlFor: (path) => options.media.urlFor(path),
    readFile: async (path) => (await options.media.read(path))?.data,
    samplePhotoUrl: options.samplePhotoUrl,
    invalidate: (b, p) => approvals!.invalidate(b, p),
  });
  weekly = createWeeklyUpdates({
    db,
    workflow,
    messaging,
    model,
    afterPlan: (businessId, weekId) => drafts!.draftWeek(businessId, weekId),
    ...(options.now ? { now: options.now } : {}),
    oneShot,
  });

  return {
    messaging,
    workflow,
    onboarding,
    weekly,
    drafts,
    approvals,
    scheduling,
    schedule,
    publishing,
    channelHealth,
    ...(billing ? { billing, billingHold: { tick: (at: Date, o?: { businessId?: string }) => billing.holdTick(at, o) } } : {}),
    cancellation,
    dataDeletion,
    monthlyReport,
    start: () => messaging.startSweep(),
  };
}
