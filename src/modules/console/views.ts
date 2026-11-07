import type * as schema from '../../db/schema.js';

// The read models of the console's tabs (technical-design.md, "Console (Phase 1)"). console.ts builds
// them with withSystem('console'); page.tsx renders them; the JSON API returns them as they are.
// Money is a number of US dollars (numeric columns come back from Postgres as strings).

export interface Overview {
  /** Count of businesses per business_status (only statuses with at least one business). */
  businesses: Record<string, number>;
  /** Open console items per kind. */
  openItems: Record<string, number>;
  /** Agent turns started in the 24 hours before `now`. */
  agentTurns24h: { count: number; failed: number; handedOff: number; costUsd: number };
  /** Model runs created in the 24 hours before `now`; failed = `valid` false or an error. */
  modelRuns24h: { count: number; failed: number; costUsd: number };
  /** Model cost per UTC day, the 14 days ending with today, oldest first, zero-filled; `day` is YYYY-MM-DD. */
  costByDay: Array<{ day: string; usd: number }>;
  /** Publications by status now: scheduled (status scheduled), published in the last 7 days (published_at), failed (status failed). */
  publications: { scheduled: number; published7d: number; failed: number };
  /** The newest 10 failures: model runs with valid false or an error, and failed publications, newest first. */
  recentFailures: FailureRow[];
  /** The newest 10 agent turns across businesses, without their steps. */
  recentTurns: AgentTurnSummary[];
}

export interface FailureRow {
  kind: 'model_run' | 'publication';
  id: string;
  businessId: string | null;
  at: Date;
  /** The task for a model run, the network for a publication. */
  label: string;
  error: string | null;
}

export interface AgentTurnSummary {
  id: string;
  businessId: string;
  agent: string;
  status: string;
  stopReason: string | null;
  costUsd: number;
  durationMs: number | null;
  stepCount: number;
  startedAt: Date;
}

export interface BusinessRow {
  id: string;
  name: string;
  status: string;
  step: string | null;
  handoffAt: Date | null;
  openQuestion: string | null;
  lastInboundAt: Date | null;
  /** Open console items of the business. */
  openItems: number;
  /** Publications of the business that are published (status published), all time. */
  published: number;
  /** The business's model spend, all time, in US dollars. */
  spendUsd: number;
  /** The newest message, for the conversation list. */
  lastMessage: { body: string | null; kind: string; direction: string; createdAt: Date } | null;
  createdAt: Date;
}

export interface BusinessDetail extends BusinessRow {
  /** The profile jsonb as stored (BusinessProfile, or BusinessProfileDraft while onboarding). */
  profile: unknown;
  style: string | null;
  timezone: string;
  channels: Array<{ id: string; network: string; status: string; verifiedAt: Date | null; lastHealthCheckAt: Date | null }>;
  subscription: { plan: string; status: string; currentPeriodEnd: Date | null; heldAt: Date | null } | null;
  /** Total model spend of the business, all time and in the last 24 hours. */
  costUsd: { total: number; last24h: number };
}

export interface PostDetail {
  id: string;
  businessId: string;
  status: string;
  format: string;
  position: number;
  weekStart: string | null;
  currentVersionId: string | null;
  updatedAt: Date;
  /** Every version, newest first. */
  versions: VersionDetail[];
  publications: PublicationDetail[];
}

export interface VersionDetail {
  id: string;
  versionNumber: number;
  contentHash: string;
  factCheckPassed: boolean;
  /** ChannelCaptions: network -> { text, hashtags }. */
  captions: Record<string, { text: string; hashtags: string[] }>;
  /** RenderedMedia: network -> media_asset ids in slide order (open with /console/media/:id). */
  renderedMedia: Record<string, string[]>;
  createdAt: Date;
  /** Approvals of this version; `invalidatedAt` null means it still stands. Read only. */
  approvals: Array<{ id: string; approvedAt: Date; invalidatedAt: Date | null; approvedVersionHash: string }>;
}

export interface PublicationDetail {
  id: string;
  network: string;
  status: string;
  scheduledFor: Date | null;
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
  approvedVersionHash: string;
}

/** A model run without its input and output. */
export interface ModelRunSummary {
  id: string;
  businessId: string | null;
  task: string;
  promptVersion: number;
  provider: string;
  model: string;
  attempt: number;
  valid: boolean;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number;
  durationMs: number | null;
  agentTurnId: string | null;
  createdAt: Date;
}

export type ModelRunRow = typeof schema.modelRun.$inferSelect;

export interface SystemSettings {
  publishingPaused: boolean;
  pausedReason: string | null;
  pausedAt: Date | null;
  pausedBy: string | null;
  agentDailyCostCapUsd: number;
}

export interface ModelTaskRow {
  task: string;
  provider: string;
  model: string;
  fallbackProvider: string | null;
  fallbackModel: string | null;
  temperature: number;
  maxCostUsd: number;
  maxRetries: number;
  activePromptVersion: number;
  /** The versions in prompt_template for the task, ascending. */
  promptVersions: number[];
  updatedAt: Date;
}

export interface AgentConfigRow {
  agent: string;
  maxSteps: number;
  maxToolCalls: number;
  maxTurnCostUsd: number;
  maxBusinessDailyCostUsd: number;
  timeoutMs: number;
  minConfidence: number;
  maxRefusals: number;
  maxRepeatedQuestions: number;
  updatedAt: Date;
}

export type ConsoleActionRow = typeof schema.consoleAction.$inferSelect;

/** The editable model task fields (technical-design.md); the provider is not editable. */
export interface ModelTaskPatch {
  model?: string;
  fallbackModel?: string | null;
  temperature?: number;
  maxCostUsd?: number;
  maxRetries?: number;
  activePromptVersion?: number;
}

export type AgentConfigPatch = Partial<Omit<AgentConfigRow, 'agent' | 'updatedAt'>>;

/** Who wrote, and an optional note, for every configuration or profile write (a console_action row). */
export interface WriteMeta {
  actor: string;
  reason?: string;
}

/** A range of UTC days, both included (YYYY-MM-DD). */
export interface InsightsRange {
  from: string;
  to: string;
}

/**
 * The Insights tab (technical-design.md, "Console (Phase 1)"): product and funnel numbers across every
 * business. "In the range" means between the start of `from` and the end of `to` (UTC); "now" fields
 * are the current state whatever the range.
 */
export interface Insights {
  range: InsightsRange & { days: number };
  /**
   * Businesses created in the range: per UTC day (zero-filled, oldest first), and per business week:
   * Sunday 00:00 in each business's own timezone (localWeek in the workflow module), zero-filled from the
   * Asia/Jerusalem week of the range's start to that of its end.
   */
  newBusinesses: { total: number; perDay: Array<{ day: string; n: number }>; perWeek: Array<{ weekStart: string; n: number }> };
  /** Businesses per business_status now (every status, zeros included). */
  statuses: Record<string, number>;
  /**
   * The funnel now: onboarding businesses per onboarding step, and active businesses per conversation
   * state, every step in contract order (zeros included); a business without a conversation_state row
   * counts under its first step.
   */
  funnel: { onboarding: Array<{ step: string; n: number }>; conversation: Array<{ step: string; n: number }> };
  /** Messages with a business in the range; `businessesWriting` = businesses with at least one inbound message; `top` = the 20 businesses with the most messages. */
  messages: { inbound: number; outbound: number; businessesWriting: number; top: Array<{ businessId: string; name: string; inbound: number; outbound: number }> };
  /**
   * drafted = first versions (version_number 1) written in the range; approved = posts with an approval
   * in the range that was not invalidated; published = publications with published_at in the range.
   * byNetwork: per network in the network enum's order, publications scheduled for the range, published in it, and failed (status
   * failed, last updated in it).
   */
  posts: { drafted: number; approved: number; published: number; byNetwork: Array<{ network: string; scheduled: number; published: number; failed: number }> };
  /**
   * This week's weekly update for businesses active now: each business's current week, Sunday 00:00
   * in its own timezone (`weekStart` shows the Asia/Jerusalem one). done = received, needs_review or planned; reminded = reminded with no reply yet;
   * awaiting; skipped; noRow = active businesses without a row for the week.
   */
  weekly: { weekStart: string; active: number; done: number; reminded: number; awaiting: number; skipped: number; noRow: number };
  /**
   * versioned = posts whose first version was written in the range; approved = those of them with any
   * approval (now); rate = approved / versioned (null when none). Minutes from a version's creation to
   * its approval, for approvals in the range (null when none).
   */
  approval: { versioned: number; approved: number; rate: number | null; medianMinutes: number | null; p90Minutes: number | null };
  /** Agent turns started in the range, those handed off, and the share handed off (null when none). */
  agent: { turns: number; handedOff: number; handOffRate: number | null };
  /** Model spend in the range: total, per UTC day (zero-filled), and per business that spent anything (null when none). */
  cost: { totalUsd: number; perDay: Array<{ day: string; usd: number }>; perBusinessUsd: number | null };
}
