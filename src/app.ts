import type { MessagingProvider } from './contracts/providers/messaging.js';
import type { ModelProvider } from './contracts/providers/model.js';
import type { PublishingProvider } from './contracts/providers/publishing.js';
import type { TemplateRenderer } from './contracts/providers/renderer.js';
import type { Database } from './db/index.js';
import { type BusinessRenderContext, renderStyleSamples } from './modules/design/index.js';
import { createMessaging, type MediaStorage, type Messaging, type Timers } from './modules/messaging/index.js';
import { createModelLayer } from './modules/model-layer/index.js';
import { createChannels } from './modules/publishing/index.js';
import {
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

  const messaging = createMessaging({
    db,
    provider: providers.messaging,
    businessNumber: options.businessNumber,
    media: options.media,
    handler: {
      // Each flow ignores a business outside its status. The weekly flow runs first, so a burst that
      // completes onboarding is not read again as a weekly update.
      async handleInbound(burst) {
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
      options.design.forBusiness({ businessName, languages: languages as ['he'], storagePrefix: `${businessId}/posts` }).render(request),
    mediaUrl: (b, a) => messaging.mediaUrl(b, a),
    urlFor: (path) => options.media.urlFor(path),
    readFile: async (path) => (await options.media.read(path))?.data,
    samplePhotoUrl: options.samplePhotoUrl,
  });
  weekly = createWeeklyUpdates({
    db,
    workflow,
    messaging,
    model,
    afterPlan: (businessId, weekId) => drafts!.draftWeek(businessId, weekId),
    ...(options.now ? { now: options.now } : {}),
  });

  return { messaging, workflow, onboarding, weekly, drafts, start: () => messaging.startSweep() };
}
