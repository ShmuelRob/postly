import type { InboundMessage, MessagingProvider } from './contracts/providers/messaging.js';
import type { ModelProvider } from './contracts/providers/model.js';
import type { PublishingProvider } from './contracts/providers/publishing.js';
import type { TemplateRenderer } from './contracts/providers/renderer.js';
import type { Database } from './db/index.js';
import { type BusinessRenderContext, renderStyleSamples } from './modules/design/index.js';
import { createMessaging, type MediaStorage, type Messaging, type Timers } from './modules/messaging/index.js';
import { createModelLayer } from './modules/model-layer/index.js';
import { eq } from 'drizzle-orm';
import { BusinessProfile } from './contracts/business-profile.js';
import * as schema from './db/schema.js';
import {
  createChannels,
  createPublishingJob,
  createScheduling,
  proposeTimes,
  type Publishing,
  type PublishingNotice,
  type Scheduling,
} from './modules/publishing/index.js';
import {
  createApprovals,
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

export interface AppOptions {
  db: Database;
  providers: {
    messaging: MessagingProvider;
    publishing: PublishingProvider;
    /** By the name `model_task_config.provider` uses, for example `google`. */
    models: Record<string, ModelProvider>;
  };
  /** The design module's renderer factory (`createDesignRenderer(...).forBusiness`). */
  design: { forBusiness(business: BusinessRenderContext): TemplateRenderer };
  /** File storage for inbound media and renders, with the URLs providers fetch them from. */
  media: MediaStorage & { read(path: string): Promise<{ data: Uint8Array } | undefined> };
  businessNumber: string;
  /** The photo used for the onboarding style samples when the owner sent none. */
  samplePhotoUrl: string;
  burstQuietMs?: number;
  timers?: Timers;
  now?: () => Date;
  logger?: WorkflowLogger;
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
  /**
   * Starts background work of the process that receives webhooks: the sweep of inbound messages
   * never processed (review queue item 14), at startup and then every quiet window. It runs in the
   * web process, next to the bursts it must not hand over twice. Returns a stop function.
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
    ...(options.now ? { now: options.now } : {}),
  });
  const model = createModelLayer({ db, providers: providers.models, resolveMediaUrl: (b, a) => messaging.mediaUrl(b, a) });
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

  const channels = createChannels({ db, provider: providers.publishing, apply: (b, r) => workflow.apply(b, r) });

  onboarding = createOnboarding({
    db,
    workflow,
    messaging,
    model,
    mediaUrl: (b, a) => messaging.mediaUrl(b, a),
    channels,
    samplePhotoUrl: options.samplePhotoUrl,
    async renderSamples({ businessId, businessName, ...sample }) {
      const renderer = options.design.forBusiness({ businessName, languages: ['he'], storagePrefix: `${businessId}/samples` });
      const samples = await renderStyleSamples(renderer, { ...sample, overlayText: businessName });
      return samples.map((s) => ({ style: s.style, url: options.media.urlFor(s.storagePath) }));
    },
  });

  drafts = createDrafts({
    db,
    workflow,
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
  });

  return { messaging, workflow, onboarding, weekly, drafts, approvals, scheduling, schedule, publishing, start: () => messaging.startSweep() };
}
