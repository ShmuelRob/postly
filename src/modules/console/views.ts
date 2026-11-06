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
