import { z } from 'zod';
import { BusinessProfileDraft } from './business-profile.js';
import { AgentContext, AgentStep, AgentStepOutput } from './agent.js';
import { Caption, ChannelCaptions, FACT_TYPES, Fact, PREFERENCE_SCOPES, PlannedPost } from './content.js';
import { ContentType, Language, Network, POST_FORMATS, Uuid } from './common.js';
import { EditCrop, RotateDeg, ToneAdjust } from './design-spec.js';

export { Caption, ChannelCaptions, FACT_TYPES, Fact, PREFERENCE_SCOPES, PlannedPost };
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


const WeeklyPlanningInput = z.object({
  facts: z.array(Fact),
  postsPerWeek: z.int().min(2).max(5),
  contentTypes: z.array(ContentType).min(1),
  formats: z.array(z.enum(POST_FORMATS)).min(1),
  mediaAssetIds: z.array(Uuid),
});
const WeeklyPlanningOutput = z.object({ posts: z.array(PlannedPost).min(2).max(5) });

// caption_writing


const CaptionWritingInput = z.object({
  plan: PlannedPost,
  facts: z.array(Fact),
  businessContext: z.string(),
  preferenceRules: z.array(z.string()),
  networks: z.array(Network).min(1),
  languages: z.array(Language).min(1),
  tone: z.object({ register: z.string(), address: z.string(), emoji: z.boolean() }),
  fixedHashtags: z.array(z.string()),
  /** The owner's change instructions when a draft is written again (WP-32). */
  changes: z.array(text).optional(),
});
const CaptionWritingOutput = z.object({ captions: ChannelCaptions, usedFactIds: z.array(factId) });

// change_interpretation


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
  // The same rectangle as a DesignSpec crop (x, y, w, h in 0..1, inside the image), so a suggestion
  // goes into a spec unchanged; the design engine uses it as the cover focus.
  crop: EditCrop.optional(),
  // Version 2 (agent.md, Photos the agent sees): what the photo shows, for the agent, and suggested
  // edits within the photo edit ranges. Optional, so version 1 outputs stay valid.
  description: z.string().trim().min(1).max(200).optional(),
  rotateDeg: RotateDeg.optional(),
  brightness: ToneAdjust.optional(),
  contrast: ToneAdjust.optional(),
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
  // The hybrid agent (agent.md): one step of a turn, whose tool calls code checks and applies.
  // `output` is the schema the model receives; `accept` is what the model layer checks: the runtime
  // checks each call on its own (agent.md, One bad call does not sink the step).
  agent_onboarding: { input: AgentContext, output: AgentStep, accept: AgentStepOutput },
  agent_weekly: { input: AgentContext, output: AgentStep, accept: AgentStepOutput },
  agent_drafts: { input: AgentContext, output: AgentStep, accept: AgentStepOutput },
} as const;

export type ModelTaskName = keyof typeof modelTasks;
export const MODEL_TASK_NAMES = Object.keys(modelTasks) as [ModelTaskName, ...ModelTaskName[]];

export type ModelTaskInput<T extends ModelTaskName> = z.infer<(typeof modelTasks)[T]['input']>;
export type ModelTaskOutput<T extends ModelTaskName> = z.infer<(typeof modelTasks)[T]['output']>;
/** What `ModelLayer.run` returns: the task's `accept` schema when it has one, else its `output`. */
export type ModelTaskResult<T extends ModelTaskName> = (typeof modelTasks)[T] extends { accept: infer A extends z.ZodType } ? z.infer<A> : ModelTaskOutput<T>;
