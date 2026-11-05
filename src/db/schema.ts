import { sql, type SQL } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgPolicy,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { NETWORKS, POST_FORMATS, VISUAL_STYLES } from '../contracts/common.js';
import { MODEL_TASK_NAMES, PREFERENCE_SCOPES } from '../contracts/model-tasks.js';
import {
  BUSINESS_STATES,
  CHANNEL_CONNECTION_STATES,
  CONVERSATION_STEP_VALUES,
  POST_STATES,
  PUBLICATION_STATES,
  SUBSCRIPTION_STATES,
  WEEKLY_UPDATE_STATES,
} from '../contracts/state-machines/index.js';

// Implements database-schema.md. jsonb columns are validated with the named
// Zod schema from src/contracts on every write.

// Roles: one login per kind of operation, created and granted in hand-written migrations
// (database-schema.md, "Least privilege"). Policies apply to every role; only the system roles
// bypass them.

/** Row visible and writable only inside the business set by `set_config('app.business_id', ..., true)`. */
function tenantIsolation(column: AnyPgColumn) {
  const sameBusiness: SQL = sql`${column} = nullif(current_setting('app.business_id', true), '')::uuid`;
  return pgPolicy('tenant_isolation', { for: 'all', to: 'public', using: sameBusiness, withCheck: sameBusiness });
}

/** A business-owned table's (business_id, id) pair. */
type Keyed = { businessId: AnyPgColumn; id: AnyPgColumn };

/** Target of same-business foreign keys (database-schema.md, "Same-business references"). */
function businessKey(table: string, t: Keyed) {
  return unique(`${table}_business_id_id_unique`).on(t.businessId, t.id);
}

/** A foreign key that only matches a parent row of the same business. */
function sameBusiness(
  table: string,
  t: { businessId: AnyPgColumn },
  column: AnyPgColumn,
  parent: () => Keyed,
) {
  const p = parent();
  return foreignKey({
    name: `${table}_${column.name}_same_business_fk`,
    columns: [t.businessId, column],
    foreignColumns: [p.businessId, p.id],
  });
}

// Enums

export const businessStatus = pgEnum('business_status', BUSINESS_STATES);
export const conversationStep = pgEnum('conversation_step', CONVERSATION_STEP_VALUES);
export const weeklyUpdateStatus = pgEnum('weekly_update_status', WEEKLY_UPDATE_STATES);
export const postStatus = pgEnum('post_status', POST_STATES);
export const publicationStatus = pgEnum('publication_status', PUBLICATION_STATES);
export const channelConnectionStatus = pgEnum('channel_connection_status', CHANNEL_CONNECTION_STATES);
export const subscriptionStatus = pgEnum('subscription_status', SUBSCRIPTION_STATES);
export const network = pgEnum('network', NETWORKS);
export const visualStyle = pgEnum('visual_style', VISUAL_STYLES);
export const postFormat = pgEnum('post_format', POST_FORMATS);
export const mediaKind = pgEnum('media_kind', ['logo', 'photo', 'voice', 'rendered']);
export const mediaSource = pgEnum('media_source', ['owner', 'library', 'render']);
export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound']);
export const messageKind = pgEnum('message_kind', ['text', 'voice', 'image', 'button_reply', 'buttons', 'template']);
export const preferenceScope = pgEnum('preference_scope', PREFERENCE_SCOPES);
export const modelTask = pgEnum('model_task', MODEL_TASK_NAMES);
export const consoleItemKind = pgEnum('console_item_kind', [
  'model_validation_failed',
  'extraction_failed',
  'draft_failed',
  'publication_failed',
  'channel_disconnected',
  'unknown_number',
  'handoff',
  'payment_link_failed',
]);
export const consoleItemStatus = pgEnum('console_item_status', ['open', 'resolved']);

// Column helpers

const tz = (name: string) => timestamp(name, { withTimezone: true });
const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => tz('created_at').notNull().defaultNow();
const updatedAt = () => tz('updated_at').notNull().defaultNow();
const businessId = () =>
  uuid('business_id')
    .notNull()
    .references(() => business.id, { onDelete: 'cascade' });
const optionalBusinessId = () => uuid('business_id').references(() => business.id, { onDelete: 'cascade' });

// Tables

export const business = pgTable(
  'business',
  {
    id: id(),
    status: businessStatus('status').notNull().default('onboarding'),
    name: text('name').notNull(),
    /** BusinessProfile once active; BusinessProfileDraft during onboarding. */
    profile: jsonb('profile').notNull().default({}),
    style: visualStyle('style'),
    approverPhone: text('approver_phone').notNull().unique(),
    timezone: text('timezone').notNull().default('Asia/Jerusalem'),
    cancelledAt: tz('cancelled_at'),
    dataDeleteAfter: tz('data_delete_after'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [tenantIsolation(t.id)],
);

export const channelConnection = pgTable(
  'channel_connection',
  {
    id: id(),
    businessId: businessId(),
    network: network('network').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id'),
    status: channelConnectionStatus('status').notNull().default('pending'),
    verifiedAt: tz('verified_at'),
    lastHealthCheckAt: tz('last_health_check_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique().on(t.businessId, t.network), businessKey('channel_connection', t), tenantIsolation(t.businessId)],
);

export const conversationState = pgTable(
  'conversation_state',
  {
    businessId: uuid('business_id')
      .primaryKey()
      .references(() => business.id, { onDelete: 'cascade' }),
    step: conversationStep('step').notNull().default('intro'),
    /** OpenQuestion or null. */
    openQuestion: jsonb('open_question'),
    handoffAt: tz('handoff_at'),
    lastInboundAt: tz('last_inbound_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [tenantIsolation(t.businessId)],
);

export const message = pgTable(
  'message',
  {
    id: id(),
    /** Null for unknown numbers; those rows are visible only to the system roles. */
    businessId: optionalBusinessId(),
    direction: messageDirection('direction').notNull(),
    kind: messageKind('kind').notNull(),
    provider: text('provider').notNull(),
    providerMessageId: text('provider_message_id').notNull(),
    fromPhone: text('from_phone').notNull(),
    toPhone: text('to_phone').notNull(),
    body: text('body'),
    payload: jsonb('payload'),
    mediaAssetIds: uuid('media_asset_ids').array().notNull().default([]),
    processedAt: tz('processed_at'),
    /** Set when messaging claims the message to hand it over; a claim older than 5 minutes may be taken again (T2). */
    claimedAt: tz('claimed_at'),
    /** Arrival order, for messages whose provider timestamps tie (T2). */
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.provider, t.providerMessageId),
    businessKey('message', t),
    tenantIsolation(t.businessId),
    index('message_unprocessed_inbound_idx')
      .on(t.businessId, t.fromPhone, t.createdAt)
      .where(sql`${t.direction} = 'inbound' and ${t.processedAt} is null`),
  ],
);

export const mediaAsset = pgTable(
  'media_asset',
  {
    id: id(),
    businessId: businessId(),
    kind: mediaKind('kind').notNull(),
    source: mediaSource('source').notNull(),
    storagePath: text('storage_path').notNull(),
    mimeType: text('mime_type').notNull(),
    width: integer('width'),
    height: integer('height'),
    sha256: text('sha256').notNull(),
    retainUntil: tz('retain_until'),
    createdAt: createdAt(),
  },
  (t) => [tenantIsolation(t.businessId)],
);

export const preferenceRule = pgTable(
  'preference_rule',
  {
    id: id(),
    businessId: businessId(),
    scope: preferenceScope('scope').notNull(),
    rule: text('rule').notNull(),
    sourceMessageId: uuid('source_message_id'),
    sourcePostVersionId: uuid('source_post_version_id'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    sameBusiness('preference_rule', t, t.sourceMessageId, (): Keyed => message),
    sameBusiness('preference_rule', t, t.sourcePostVersionId, (): Keyed => postVersion),
    tenantIsolation(t.businessId),
  ],
);

export const weeklyUpdate = pgTable(
  'weekly_update',
  {
    id: id(),
    businessId: businessId(),
    weekStart: date('week_start').notNull(),
    status: weeklyUpdateStatus('status').notNull().default('awaiting'),
    originalText: text('original_text'),
    transcript: text('transcript'),
    mediaAssetIds: uuid('media_asset_ids').array().notNull().default([]),
    /** FactExtractionOutput. */
    extractedFacts: jsonb('extracted_facts'),
    reminderSentAt: tz('reminder_sent_at'),
    receivedAt: tz('received_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique().on(t.businessId, t.weekStart), businessKey('weekly_update', t), tenantIsolation(t.businessId)],
);

export const post = pgTable(
  'post',
  {
    id: id(),
    businessId: businessId(),
    weeklyUpdateId: uuid('weekly_update_id').notNull(),
    position: integer('position').notNull(),
    status: postStatus('status').notNull().default('planned'),
    format: postFormat('format').notNull(),
    /** PlannedPost. */
    plan: jsonb('plan').notNull(),
    currentVersionId: uuid('current_version_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    businessKey('post', t),
    sameBusiness('post', t, t.weeklyUpdateId, (): Keyed => weeklyUpdate),
    sameBusiness('post', t, t.currentVersionId, (): Keyed => postVersion),
    tenantIsolation(t.businessId),
  ],
);

/** Immutable once written; a change creates a new version. */
export const postVersion = pgTable(
  'post_version',
  {
    id: id(),
    businessId: businessId(),
    postId: uuid('post_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    /** ChannelCaptions. */
    captions: jsonb('captions').notNull(),
    /** RenderedMedia: asset ids per network. */
    renderedMedia: jsonb('rendered_media').notNull(),
    /** FactSource[]. */
    factSources: jsonb('fact_sources').notNull(),
    factCheckPassed: boolean('fact_check_passed').notNull(),
    contentHash: text('content_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.postId, t.versionNumber),
    businessKey('post_version', t),
    sameBusiness('post_version', t, t.postId, (): Keyed => post).onDelete('cascade'),
    tenantIsolation(t.businessId),
  ],
);

/** Immutable except for invalidated_at. */
export const approval = pgTable(
  'approval',
  {
    id: id(),
    businessId: businessId(),
    postId: uuid('post_id').notNull(),
    postVersionId: uuid('post_version_id').notNull(),
    approvedVersionHash: text('approved_version_hash').notNull(),
    approverPhone: text('approver_phone').notNull(),
    /** The button reply; unique so a tap is never counted twice. */
    messageId: uuid('message_id').notNull().unique(),
    approvedAt: tz('approved_at').notNull(),
    invalidatedAt: tz('invalidated_at'),
    createdAt: createdAt(),
  },
  (t) => [
    businessKey('approval', t),
    sameBusiness('approval', t, t.postId, (): Keyed => post),
    sameBusiness('approval', t, t.postVersionId, (): Keyed => postVersion),
    sameBusiness('approval', t, t.messageId, (): Keyed => message),
    tenantIsolation(t.businessId),
  ],
);

export const publication = pgTable(
  'publication',
  {
    id: id(),
    businessId: businessId(),
    postId: uuid('post_id').notNull(),
    approvalId: uuid('approval_id').notNull(),
    /** Copied from the approval; checked again by the publishing job. */
    approvedVersionHash: text('approved_version_hash').notNull(),
    channelConnectionId: uuid('channel_connection_id').notNull(),
    network: network('network').notNull(),
    scheduledFor: tz('scheduled_for').notNull(),
    status: publicationStatus('status').notNull().default('scheduled'),
    providerPostId: text('provider_post_id'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    publishedAt: tz('published_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique().on(t.approvalId, t.network),
    sameBusiness('publication', t, t.postId, (): Keyed => post),
    sameBusiness('publication', t, t.approvalId, (): Keyed => approval),
    sameBusiness('publication', t, t.channelConnectionId, (): Keyed => channelConnection),
    tenantIsolation(t.businessId),
  ],
);

/** Payment card details are never stored. */
export const subscription = pgTable(
  'subscription',
  {
    id: id(),
    businessId: businessId().unique(),
    plan: text('plan').notNull(),
    status: subscriptionStatus('status').notNull().default('pending'),
    provider: text('provider').notNull(),
    providerCustomerId: text('provider_customer_id'),
    providerSubscriptionId: text('provider_subscription_id'),
    currentPeriodEnd: tz('current_period_end'),
    /** Billing hold (T16): when the grace period started; null once paid. */
    graceStartedAt: tz('grace_started_at'),
    remindersSent: integer('reminders_sent').notNull().default(0),
    /** When billing paused the business; null when billing holds nothing. */
    heldAt: tz('held_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [tenantIsolation(t.businessId)],
);

export const modelRun = pgTable(
  'model_run',
  {
    id: id(),
    /** Null for example-set runs; those rows are visible only to the system roles. */
    businessId: optionalBusinessId(),
    task: modelTask('task').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    attempt: integer('attempt').notNull().default(1),
    input: jsonb('input').notNull(),
    output: jsonb('output'),
    valid: boolean('valid').notNull(),
    error: text('error'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
  },
  (t) => [tenantIsolation(t.businessId)],
);

export const consoleItem = pgTable(
  'console_item',
  {
    id: id(),
    /** Null for unknown numbers. */
    businessId: optionalBusinessId(),
    kind: consoleItemKind('kind').notNull(),
    status: consoleItemStatus('status').notNull().default('open'),
    referenceId: uuid('reference_id'),
    details: jsonb('details').notNull().default({}),
    resolvedAt: tz('resolved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [tenantIsolation(t.businessId)],
);

/**
 * The workflow audit trail (WP-46), append-only. business_id is a plain value with no foreign key, so
 * the rows stay after the business is deleted (database-schema.md, "workflow_event").
 */
export const workflowEvent = pgTable(
  'workflow_event',
  {
    id: id(),
    businessId: uuid('business_id').notNull(),
    machine: text('machine').notNull(),
    rowId: uuid('row_id').notNull(),
    event: text('event').notNull(),
    source: text('source').notNull(),
    role: text('role').notNull(),
    actor: text('actor').notNull(),
    outcome: text('outcome').notNull(),
    fromState: text('from_state'),
    toState: text('to_state'),
    guard: text('guard'),
    reason: text('reason'),
    detail: text('detail'),
    correlationId: text('correlation_id'),
    createdAt: createdAt(),
  },
  (t) => [tenantIsolation(t.businessId)],
);

// System tables: no business_id.

export const modelTaskConfig = pgTable('model_task_config', {
  task: modelTask('task').primaryKey(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  fallbackProvider: text('fallback_provider'),
  fallbackModel: text('fallback_model'),
  temperature: real('temperature').notNull(),
  maxCostUsd: numeric('max_cost_usd', { precision: 10, scale: 6 }).notNull(),
  maxRetries: integer('max_retries').notNull().default(2),
  activePromptVersion: integer('active_prompt_version').notNull(),
  updatedAt: updatedAt(),
});

/** Versions are immutable. */
export const promptTemplate = pgTable(
  'prompt_template',
  {
    id: id(),
    task: modelTask('task').notNull(),
    version: integer('version').notNull(),
    template: text('template').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.task, t.version)],
);

/** Single row holding the global publishing pause. */
export const systemControl = pgTable(
  'system_control',
  {
    id: integer('id').primaryKey().default(1),
    publishingPaused: boolean('publishing_paused').notNull().default(false),
    pausedReason: text('paused_reason'),
    pausedAt: tz('paused_at'),
    pausedBy: text('paused_by'),
    updatedAt: updatedAt(),
  },
  (t) => [check('system_control_single_row', sql`${t.id} = 1`)],
);

/** The monthly price of each plan, append-only: the rows are the history; the newest row is the price (T1). */
export const planPrice = pgTable(
  'plan_price',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    plan: text('plan').notNull(),
    amountAgorot: integer('amount_agorot').notNull(),
    currency: text('currency').notNull().default('ILS'),
    changedBy: text('changed_by').notNull(),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [check('plan_price_positive', sql`${t.amountAgorot} > 0`), check('plan_price_currency', sql`${t.currency} = 'ILS'`), index('plan_price_plan_idx').on(t.plan, t.id)],
);
