import { z } from 'zod';
import { BusinessProfileDraft } from './business-profile.js';
import { ChannelCaptions, FACT_TYPES, Fact, PREFERENCE_SCOPES, PlannedPost } from './content.js';
import { Language, Network, PostFormat, Timestamp, Uuid } from './common.js';
import { DesignSpec, PhotoEdit } from './design-spec.js';
import { OpenQuestion } from './open-question.js';
import { CONVERSATION_STEP_VALUES, POST_STATES } from './state-machines/index.js';

// The hybrid agent's contracts (contracts.md, Agent; agent.md, Tools). The agent acts only through
// these tool calls; code checks each one and applies it through the module that owns the data. No
// tool takes or returns an InboundMessage, a button payload or an approval, so no agent output can
// reach ApprovalService. Code checks the schemas cannot express are listed per tool in agent.md.

const text = z.string().trim().min(1);
const factId = z.string().min(1);

export const AGENT_NAMES = ['onboarding', 'weekly', 'drafts'] as const;
export const AgentName = z.enum(AGENT_NAMES);
export type AgentName = z.infer<typeof AgentName>;

// Persona (agent.md, A1 and A2, decided 2026-11-05). The global name is stored in
// system_control.agent_name; this is its default, and a business may override it in its profile.

export const DEFAULT_AGENT_NAME = { he: 'פוסטלי', en: 'Postly', ar: 'Postly', ru: 'Postly' } as const satisfies Record<
  z.infer<typeof Language>,
  string
>;
/** The persona speaks as a woman: feminine grammatical gender, everywhere. */
export const AGENT_PERSONA_GENDER = 'feminine' as const;

/** The persona's name for a business: its override, else the global name for the language. */
export function personaName(
  profile: { persona?: { agentName?: string | undefined } | undefined },
  language: z.infer<typeof Language>,
  globalName: Partial<Record<z.infer<typeof Language>, string>> = DEFAULT_AGENT_NAME,
): string {
  return profile.persona?.agentName ?? globalName[language] ?? DEFAULT_AGENT_NAME[language];
}

// Tools

export const AGENT_TOOL_NAMES = [
  'ask_owner',
  'set_profile_field',
  'record_fact',
  'request_photo',
  'record_decline',
  'plan_posts',
  'create_draft',
  'apply_change',
  'hand_off_to_console',
  'end_turn',
] as const;
export const AgentToolName = z.enum(AGENT_TOOL_NAMES);
export type AgentToolName = z.infer<typeof AgentToolName>;

const factTypes = FACT_TYPES.join('|');

/** `profile:<field>`, `detail:<factType>`, or one of the fixed topics (agent.md, ask_owner). */
const AskTopic = z
  .string()
  .regex(new RegExp(`^(profile:[A-Za-z.]+|detail:(${factTypes})|photo_choice|clarify_change|anything_else|info)$`));

const AskOwner = z.object({
  tool: z.literal('ask_owner'),
  text: text.max(600),
  topic: AskTopic,
  expects: z.enum(['answer', 'none']),
  fields: z.array(text).optional(),
});

/**
 * Profile paths the agent may set. Not `approverPhone`, `style` (code reads the owner's style
 * choice), `brand.logoAssetId` (code sets it from the image answering the logo request), or
 * `persona` (set by the team). `channels` after onboarding is refused in code.
 */
export const AGENT_PROFILE_FIELDS = [
  'name',
  'field',
  'mainProducts',
  'location.city',
  'location.address',
  'location.hours',
  'location.fulfillment',
  'targetAudience',
  'differentiator',
  'languages',
  'tone.register',
  'tone.address',
  'tone.emoji',
  'contentTypes',
  'formats',
  'channels',
  'postsPerWeek',
  'schedule.publishOnShabbatAndHolidays',
  'schedule.days',
  'schedule.hours',
  'brand.colors',
  'callToAction',
  'contact.phone',
  'contact.whatsapp',
  'contact.website',
  'contact.orderUrl',
  'forbiddenTopics',
  'fixedHashtags',
] as const;
export type AgentProfileField = (typeof AGENT_PROFILE_FIELDS)[number];

/** Fields whose value must come with a verbatim quote of the owner's words. */
export const QUOTED_PROFILE_FIELDS: readonly AgentProfileField[] = AGENT_PROFILE_FIELDS.filter(
  (f) =>
    ['name', 'differentiator', 'mainProducts', 'fixedHashtags'].includes(f) ||
    f.startsWith('location.') ||
    f.startsWith('contact.') ||
    f.startsWith('schedule.'),
);

function unwrapOptional(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodType) : schema;
}

/** The schema a field's value must match: that field's own schema in `BusinessProfileDraft`. */
export function profileFieldValueSchema(field: AgentProfileField): z.ZodType {
  const [top, sub] = field.split('.') as [keyof typeof BusinessProfileDraft.shape, string | undefined];
  const schema = unwrapOptional(BusinessProfileDraft.shape[top]);
  if (!sub) return schema;
  return unwrapOptional((schema as z.ZodObject<z.ZodRawShape>).shape[sub] as z.ZodType);
}

const SetProfileField = z
  .object({
    tool: z.literal('set_profile_field'),
    field: z.enum(AGENT_PROFILE_FIELDS),
    value: z.unknown(),
    sourceQuote: text.optional(),
  })
  .superRefine((call, ctx) => {
    if (!profileFieldValueSchema(call.field).safeParse(call.value).success)
      ctx.addIssue({ code: 'custom', path: ['value'], message: `Invalid value for ${call.field}` });
    if (QUOTED_PROFILE_FIELDS.includes(call.field) && !call.sourceQuote)
      ctx.addIssue({ code: 'custom', path: ['sourceQuote'], message: `${call.field} needs the owner's words` });
  });

const RecordFact = z.object({
  tool: z.literal('record_fact'),
  type: z.enum(FACT_TYPES),
  value: text,
  /** Verbatim in the week's update, transcript, or an owner answer this week; checked in code. */
  sourceQuote: text,
  /** An earlier fact this one corrects. */
  replaces: factId.optional(),
});

const RequestPhoto = z
  .object({
    tool: z.literal('request_photo'),
    /** `week`: a photo for this week's update, before any post exists (WP-93, agent.md). */
    purpose: z.enum(['logo', 'business', 'week', 'post']),
    postId: Uuid.optional(),
    text: text.max(600),
  })
  .refine((c) => (c.purpose === 'post') === (c.postId !== undefined), {
    message: 'A post photo request names its post, and only it does',
    path: ['postId'],
  });

const RecordDecline = z
  .object({
    tool: z.literal('record_decline'),
    what: z.string().regex(new RegExp(`^(logo|business_photos|anything_else|post_photo|detail:(${factTypes}))$`)),
    postId: Uuid.optional(),
    /** Verbatim in the owner's latest burst. */
    ownerQuote: text,
  })
  .refine((c) => c.what !== 'post_photo' || c.postId !== undefined, {
    message: 'A declined post photo names its post',
    path: ['postId'],
  });

const PlanPostsItem = PlannedPost.extend({ postId: Uuid.optional() });

const PlanPosts = z
  .object({
    tool: z.literal('plan_posts'),
    mode: z.enum(['initial', 'revise']),
    /** Never above 7 a week (agent.md, plan_posts). */
    posts: z.array(PlanPostsItem).min(1).max(7),
    /** Required in code when the plan departs from the profile. */
    ownerQuote: text.optional(),
  })
  .superRefine((call, ctx) => {
    call.posts.forEach((post, i) => {
      if (call.mode === 'initial' && post.postId)
        ctx.addIssue({ code: 'custom', path: ['posts', i, 'postId'], message: 'An initial plan has no post ids' });
    });
    if (call.mode === 'revise' && !call.posts.some((p) => p.postId))
      ctx.addIssue({ code: 'custom', path: ['posts'], message: 'A revised plan names the posts it changes' });
  });

const CreateDraft = z.object({
  tool: z.literal('create_draft'),
  postId: Uuid,
  captions: ChannelCaptions,
  usedFactIds: z.array(factId),
  design: DesignSpec,
});

const ApplyChange = z
  .object({
    tool: z.literal('apply_change'),
    postId: Uuid,
    /** Verbatim in the owner's latest burst: the fix the owner asked for. */
    ownerQuote: text,
    captions: ChannelCaptions.optional(),
    design: DesignSpec.optional(),
    networks: z.array(Network).min(1).optional(),
    rule: z.object({ text, scope: z.enum(PREFERENCE_SCOPES) }).optional(),
  })
  .refine((c) => c.captions !== undefined || c.design !== undefined || c.networks !== undefined, {
    message: 'A change sets captions, design or networks',
  });

export const HAND_OFF_REASONS = [
  'owner_asked_for_person',
  'unclear',
  'out_of_scope',
  'sensitive',
  'repeated_failure',
] as const;

const HandOffToConsole = z.object({
  tool: z.literal('hand_off_to_console'),
  reason: z.enum(HAND_OFF_REASONS),
  /** For the team; never sent to the owner. */
  note: text.max(300),
});

const EndTurn = z.object({ tool: z.literal('end_turn') });

/**
 * One tool call. A plain union of objects with a literal `tool` (not a discriminated union), so its
 * JSON Schema uses `anyOf`, which the model provider accepts for structured output.
 */
export const AgentToolCall = z.union([
  AskOwner,
  SetProfileField,
  RecordFact,
  RequestPhoto,
  RecordDecline,
  PlanPosts,
  CreateDraft,
  ApplyChange,
  HandOffToConsole,
  EndTurn,
]);
export type AgentToolCall = z.infer<typeof AgentToolCall>;

/** The output of every agent task: the tool calls to run in order, and a confidence. */
export const AgentStep = z.object({
  calls: z.array(AgentToolCall).min(1).max(4),
  confidence: z.number().min(0).max(1),
});
export type AgentStep = z.infer<typeof AgentStep>;

export const AGENT_TOOL_REFUSAL_REASONS = [
  'not_allowed',
  'unknown_id',
  'invalid_input',
  'quote_not_found',
  'value_not_in_quote',
  'fact_mismatch',
  'forbidden_content',
  'plan_invalid',
  'badge_invalid',
  'edit_out_of_range',
  'render_failed',
  'no_change',
  'window_closed',
  'question_limit',
  'photo_request_limit',
] as const;

/** A refusal changes nothing; its reason and detail go back to the agent. */
export const AgentToolResult = z.union([
  z.object({ status: z.literal('ok'), data: z.record(z.string(), z.unknown()) }),
  z.object({ status: z.literal('refused'), reason: z.enum(AGENT_TOOL_REFUSAL_REASONS), detail: text.max(300) }),
]);
export type AgentToolResult = z.infer<typeof AgentToolResult>;

export const AGENT_TURN_STOP_REASONS = [
  'done',
  'waiting_for_owner',
  'end_turn',
  'handed_off',
  'max_steps',
  'max_tool_calls',
  'turn_budget',
  'daily_budget',
  'global_budget',
  'timeout',
  'stuck',
  'low_confidence',
  'refusals',
  'invalid_output',
] as const;
export const AgentTurnStopReason = z.enum(AGENT_TURN_STOP_REASONS);
export type AgentTurnStopReason = z.infer<typeof AgentTurnStopReason>;

// Context: the input of every agent task, built by code from one business.

const ContextPhoto = z.object({
  assetId: Uuid,
  /** The image_review notes: what the photo shows and the suggested edits. */
  description: z.string().optional(),
  usable: z.boolean().optional(),
  suggested: PhotoEdit.optional(),
});

const ContextMessage = z.object({
  role: z.enum(['owner', 'postly']),
  text: z.string(),
  at: Timestamp,
  photos: z.array(ContextPhoto),
});

const ContextPost = z.object({
  id: Uuid,
  state: z.enum(POST_STATES),
  format: PostFormat,
  plan: PlannedPost,
  captions: ChannelCaptions.optional(),
  design: DesignSpec.optional(),
});

export const AgentContext = z.object({
  agent: AgentName,
  persona: z.object({ name: text.max(30), gender: z.literal(AGENT_PERSONA_GENDER) }),
  languages: z.array(Language).min(1),
  tone: BusinessProfileDraft.shape.tone.unwrap(),
  /** The draft or the full profile, without the approver's number. */
  profile: BusinessProfileDraft.omit({ approverPhone: true }).strict(),
  missingFields: z.array(z.string()),
  /** The last 20 messages within 14 days (A10). */
  messages: z.array(ContextMessage).max(20),
  step: z.enum(CONVERSATION_STEP_VALUES),
  openQuestion: OpenQuestion.nullable(),
  week: z
    .object({
      updateText: z.string().optional(),
      transcript: z.string().optional(),
      facts: z.array(Fact),
      declines: z.array(z.string()),
    })
    .nullable(),
  posts: z.array(ContextPost),
  rules: z.array(z.string()),
  /** The last 8 post topics. */
  history: z.array(z.string()).max(8),
  tools: z.array(AgentToolName).min(1),
  doneRule: text,
  budget: z.object({ stepsLeft: z.int().min(0), costLeftUsd: z.number().min(0) }),
  toolResults: z.array(z.object({ tool: AgentToolName, result: AgentToolResult })),
});
export type AgentContext = z.infer<typeof AgentContext>;
