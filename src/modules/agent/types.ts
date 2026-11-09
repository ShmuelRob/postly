import type { AgentContext, AgentName, AgentToolCall, AgentToolName, AgentToolResult, AgentTurnStopReason } from '../../contracts/agent.js';
import type { Database } from '../../db/index.js';
import type { ModelLayer } from '../model-layer/index.js';
import type { Messaging } from '../messaging/index.js';

/** What started a turn: an owner burst routed to the agent, or a code event (agent.md, Runtime). */
export type TurnTrigger = { kind: 'burst'; messageIds: string[] } | { kind: 'event'; name: string };

/** The agent task each agent runs. */
export type AgentTask = 'agent_onboarding' | 'agent_weekly' | 'agent_drafts';

/**
 * State machine effects a tool needs, injected by the app wiring so the agent module never imports
 * workflow (agent.md, Module direction). Each agent package adds the callbacks its tools need.
 */
export interface AgentEvents {
  /**
   * A question or photo request expecting an answer was sent: the caller stores the open question
   * and applies `QUESTION_ASKED` (conversation) or `DETAIL_MISSING` (post), per state-machines.md.
   */
  questionAsked(businessId: string, question: { agent: AgentName; key: string; askedFields: string[]; postId?: string }): Promise<void>;
}

export interface AgentDeps {
  db: Database;
  models: Pick<ModelLayer, 'run' | 'costCap' | 'spentSince' | 'spentByAllSince' | 'spentOnTurn'>;
  /** Free-form sends to the approver; throws WindowClosedError outside the 24-hour window. */
  messaging: Pick<Messaging, 'sendText'>;
  events: AgentEvents;
  now?: () => Date;
  /** The agents and their tools; defaults to the registry (agents/index.ts). */
  agents?: Record<AgentName, AgentDefinition>;
  /**
   * Called once per turn that ran, after its `agent_turn` row is final (the e2e report, WP-91).
   * A null result is a call that never ran (a step below the confidence floor, or past a limit).
   */
  onTurnEnd?: (turn: TurnEnd) => void | Promise<void>;
}

export interface TurnEnd {
  agent: AgentName;
  businessId: string;
  turnId: string;
  stopReason: AgentTurnStopReason | null;
  steps: { calls: AgentToolCall[]; results: (AgentToolResult | null)[] }[];
}

/** One past successful tool call of this business, for the repeated-question limit and declines. */
export interface PastCall {
  turnId: string;
  call: AgentToolCall;
  result: AgentToolResult;
}

/** What a tool sees: the turn, its context, and the deps. */
export interface ToolContext {
  businessId: string;
  turnId: string;
  agent: AgentName;
  deps: Required<Omit<AgentDeps, 'agents' | 'onTurnEnd'>>;
  context: AgentContext;
  /** The approver's number: tools send to it, and it never enters the model's context. */
  approverPhone: string;
  /** The persona's name, for fixed copy. */
  personaName: string;
  limits: AgentLimits;
  /** Successful calls of earlier turns in scope (this onboarding, or this business week), then this turn's. */
  history: PastCall[];
  /** Counters of this turn. */
  turn: { messagesSent: number; questionsAsked: number };
}

/** How a call ended the turn, when it did. */
export type ToolStop = Extract<AgentTurnStopReason, 'waiting_for_owner' | 'end_turn' | 'handed_off' | 'stuck'>;

export interface ToolOutcome {
  result: AgentToolResult;
  stop?: ToolStop;
}

export type ToolHandler<T extends AgentToolName = AgentToolName> = (
  call: Extract<AgentToolCall, { tool: T }>,
  ctx: ToolContext,
) => Promise<ToolOutcome>;

export type ToolHandlers = { [T in AgentToolName]?: ToolHandler<T> };

/** One agent: its task, allowed tools, and its "done" rule, which code evaluates (agent.md, Agents). */
export interface AgentDefinition {
  name: AgentName;
  task: AgentTask;
  tools: readonly AgentToolName[];
  /**
   * The tools allowed in a conversation step, when the agent narrows `tools` by step (agent.md,
   * request_photo: the onboarding agent asks for photos only in brand_assets). A tool left out is not
   * in the context's tool list and a call to it is refused `not_allowed`.
   */
  toolsIn?(step: string): readonly AgentToolName[];
  /** The done rule in words, for the model's context. */
  doneRule: string;
  /** Code decides "done" after each step; stubs return false until their package lands. */
  isDone(input: { businessId: string; db: Database; turnId: string }): Promise<boolean>;
}

/** The tools an agent may call in this conversation step (agent.md, Tools: allowed for the agent and the state). */
export const toolsFor = (agent: AgentDefinition, step: string): readonly AgentToolName[] => agent.toolsIn?.(step) ?? agent.tools;

/** The limits of one agent (agent_config) and the global cap (system_control), agent.md, Limits. */
export interface AgentLimits {
  maxSteps: number;
  maxToolCalls: number;
  maxTurnCostUsd: number;
  maxBusinessDailyCostUsd: number;
  globalDailyCostUsd: number;
  timeoutMs: number;
  minConfidence: number;
  maxRefusals: number;
  maxRepeatedQuestions: number;
}

export interface TurnResult {
  /** Null when the turn did not run (another turn runs, the business is handed off, or the flow is off). */
  turnId: string | null;
  status: 'done' | 'waiting' | 'handed_off' | 'failed' | 'skipped';
  stopReason: AgentTurnStopReason | null;
  /** Messages the turn's own tools sent the owner (ask_owner, request_photo; not the hand-off line). */
  messagesSent: number;
}

export interface RunTurnOptions {
  /**
   * The owner waits on this turn and no code reply follows it unless it ends done (agent.md, Runtime,
   * "No silent turn"): a turn that ends with end_turn, not done, and nothing sent hands off.
   */
  mustReply?: boolean;
}
