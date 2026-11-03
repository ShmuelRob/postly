import type { MessagingProvider } from './contracts/providers/messaging.js';
import type { ModelProvider } from './contracts/providers/model.js';
import type { PublishingProvider } from './contracts/providers/publishing.js';
import type { TemplateRenderer } from './contracts/providers/renderer.js';
import type { Database } from './db/index.js';
import { type BusinessRenderContext, renderStyleSamples } from './modules/design/index.js';
import { createMessaging, type MediaStorage, type Messaging, type Timers } from './modules/messaging/index.js';
import { createModelLayer } from './modules/model-layer/index.js';
import { createChannels } from './modules/publishing/index.js';
import { createOnboarding, createWorkflow, type Onboarding, type Workflow, type WorkflowLogger } from './modules/workflow/index.js';

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
  media: MediaStorage;
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
}

/**
 * The composition root for the product flows: messaging hands each burst to the workflow, which
 * runs onboarding for a business in `onboarding`. Later flows (WP-31+) route active businesses.
 */
export function createApp(options: AppOptions): App {
  const { db, providers } = options;
  const workflow = createWorkflow(db, options.logger);
  let onboarding: Onboarding | undefined;

  const messaging = createMessaging({
    db,
    provider: providers.messaging,
    businessNumber: options.businessNumber,
    media: options.media,
    handler: { handleInbound: (burst) => onboarding!.handle(burst) },
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

  return { messaging, workflow, onboarding };
}
