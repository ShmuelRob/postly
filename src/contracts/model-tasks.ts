import { z } from 'zod';
import { BusinessProfileDraft } from './business-profile.js';
import { ContentType, Language, Network, POST_FORMATS, PostFormat, Uuid } from './common.js';
import { CONVERSATION_STEP_VALUES } from './state-machines/index.js';

// Model outputs are validated here before any other code sees them. No
// schema in this file may express an approval: approval comes only from a
// WhatsApp button tap (see state-machines.md).

const text = z.string().trim().min(1);
const unit = z.number().min(0).max(1);
const factId = z.string().min(1);

// intent_detection

export const INTENTS = [
  'weekly_update',
  'answer',
  'change_request',
  'schedule_response',
  'question',
  'support_request',
  'cancel_request',
  'other',
] as const;

const IntentDetectionInput = z.object({
  text,
  step: z.enum(CONVERSATION_STEP_VALUES),
  draftsOpen: z.boolean(),
});
const IntentDetectionOutput = z.object({ intent: z.enum(INTENTS), confidence: unit });

// transcription

const TranscriptionInput = z.object({ voiceAssetId: Uuid, languageHint: Language });
const TranscriptionOutput = z.object({ text: z.string(), language: Language });

// profile_extraction

const ProfileExtractionInput = z.object({
  text,
  draft: BusinessProfileDraft,
  askedFields: z.array(z.string()).min(1),
});
const ProfileExtractionOutput = z.object({
  found: BusinessProfileDraft,
  unclear: z.array(z.string()),
});

// fact_extraction

export const FACT_TYPES = [
  'price',
  'discount_percent',
  'date',
  'date_range',
  'time',
  'address',
  'phone',
  'product',
  'promotion',
  'testimonial',
  'other',
] as const;

export const Fact = z.object({
  id: factId,
  type: z.enum(FACT_TYPES),
  value: text,
  /** Verbatim quote from the owner's text or transcript; checked in code. */
  sourceQuote: text,
});
export type Fact = z.infer<typeof Fact>;

const FactExtractionInput = z.object({
  text: z.string(),
  transcript: z.string().optional(),
  profileSummary: z.string(),
});
export const FactExtractionOutput = z.object({
  facts: z
    .array(Fact)
    .refine((facts) => new Set(facts.map((f) => f.id)).size === facts.length, 'Fact ids must be unique'),
  missingDetails: z.array(text),
});

// weekly_planning

export const PlannedPost = z.object({
  topic: text,
  contentType: ContentType,
  format: PostFormat,
  factIds: z.array(factId),
  mediaAssetIds: z.array(Uuid),
  brief: text,
});
export type PlannedPost = z.infer<typeof PlannedPost>;

const WeeklyPlanningInput = z.object({
  facts: z.array(Fact),
  postsPerWeek: z.int().min(2).max(5),
  contentTypes: z.array(ContentType).min(1),
  formats: z.array(z.enum(POST_FORMATS)).min(1),
  mediaAssetIds: z.array(Uuid),
});
const WeeklyPlanningOutput = z.object({ posts: z.array(PlannedPost).min(2).max(5) });

// caption_writing

export const Caption = z.object({
  text,
  hashtags: z.array(z.string().regex(/^#\S+$/, 'Hashtags start with # and have no spaces')),
});

export const ChannelCaptions = z
  .partialRecord(Network, Caption)
  .refine((captions) => Object.keys(captions).length > 0, 'At least one network caption is required');
export type ChannelCaptions = z.infer<typeof ChannelCaptions>;

const CaptionWritingInput = z.object({
  plan: PlannedPost,
  facts: z.array(Fact),
  businessContext: z.string(),
  preferenceRules: z.array(z.string()),
  networks: z.array(Network).min(1),
  languages: z.array(Language).min(1),
  tone: z.object({ register: z.string(), address: z.string(), emoji: z.boolean() }),
  fixedHashtags: z.array(z.string()),
});
const CaptionWritingOutput = z.object({ captions: ChannelCaptions, usedFactIds: z.array(factId) });

// change_interpretation

export const PREFERENCE_SCOPES = ['caption', 'design', 'schedule', 'general'] as const;

const ChangeInterpretationInput = z.object({
  text,
  captions: ChannelCaptions,
  plan: PlannedPost,
});
const ChangeInterpretationOutput = z.object({
  changes: z
    .array(z.object({ target: z.enum(['caption', 'design', 'media', 'channels', 'schedule']), instruction: text }))
    .min(1),
  /** A lasting preference to save, when the change applies beyond this post. */
  rule: z.object({ scope: z.enum(PREFERENCE_SCOPES), text }).optional(),
});

// image_review

const ImageReviewInput = z.object({ mediaAssetId: Uuid, purpose: z.enum(['post_photo', 'logo']) });
const ImageReviewOutput = z.object({
  usable: z.boolean(),
  score: unit,
  issues: z.array(text),
  crop: z
    .object({ x: unit, y: unit, width: unit, height: unit })
    .refine((c) => c.x + c.width <= 1 && c.y + c.height <= 1, 'Crop must stay inside the image')
    .optional(),
});

// fact_check

const FactCheckInput = z.object({ caption: text, facts: z.array(Fact) });
const FactCheckOutput = z.object({ mismatches: z.array(z.object({ text, issue: text })) });

export const modelTasks = {
  intent_detection: { input: IntentDetectionInput, output: IntentDetectionOutput },
  transcription: { input: TranscriptionInput, output: TranscriptionOutput },
  profile_extraction: { input: ProfileExtractionInput, output: ProfileExtractionOutput },
  fact_extraction: { input: FactExtractionInput, output: FactExtractionOutput },
  weekly_planning: { input: WeeklyPlanningInput, output: WeeklyPlanningOutput },
  caption_writing: { input: CaptionWritingInput, output: CaptionWritingOutput },
  change_interpretation: { input: ChangeInterpretationInput, output: ChangeInterpretationOutput },
  image_review: { input: ImageReviewInput, output: ImageReviewOutput },
  fact_check: { input: FactCheckInput, output: FactCheckOutput },
} as const;

export type ModelTaskName = keyof typeof modelTasks;
export const MODEL_TASK_NAMES = Object.keys(modelTasks) as [ModelTaskName, ...ModelTaskName[]];

export type ModelTaskInput<T extends ModelTaskName> = z.infer<(typeof modelTasks)[T]['input']>;
export type ModelTaskOutput<T extends ModelTaskName> = z.infer<(typeof modelTasks)[T]['output']>;
