import {
  AgentContext,
  type AgentName,
  AgentStep,
  type AgentToolCall,
  type AgentToolResult,
  type AgentTurnStopReason,
} from '../contracts/agent.js';
import type { ModelTaskName } from '../contracts/model-tasks.js';

// The scripted agent (agent.md, Testing without paying for a model; WP-91). Every unit, db and e2e
// test runs the agents on scripts: each agent_* task returns the next AgentStep of a script the test
// supplies, turn by turn. Anything off script is a violation that fails the test, even when the
// model layer's retry or console fallback swallows the thrown error: the e2e harness checks
// `ModelSimulator.agentScriptProblems()` at teardown.

/**
 * `ModelProvider.name` of every real model adapter. The e2e harness refuses these, and a static test
 * checks that every adapter in src/modules/model-layer/adapters/ is listed.
 */
export const REAL_MODEL_PROVIDER_NAMES = ['google'] as const;

export const AGENT_TASKS = {
  onboarding: 'agent_onboarding',
  weekly: 'agent_weekly',
  drafts: 'agent_drafts',
} as const satisfies Record<AgentName, ModelTaskName>;

export function agentOfTask(task: ModelTaskName): AgentName | undefined {
  return (Object.keys(AGENT_TASKS) as AgentName[]).find((agent) => AGENT_TASKS[agent] === task);
}

/** Thrown for anything off script; the message is also kept as a violation. */
export class ScriptedAgentError extends Error {
  override name = 'ScriptedAgentError';
}

/** One entry of a scripted turn: a valid step, an invalid raw output, or a provider failure. */
export type ScriptEntry =
  | { kind: 'step'; step: AgentStep }
  /** A step built from the context it answers, for ids the test cannot know in advance (a photo the owner sends). */
  | { kind: 'from'; build: (context: AgentContext) => AgentStep }
  | { kind: 'invalid'; output: unknown }
  | { kind: 'error'; error: Error };

/** A turn: the entries served in order while the runtime keeps calling within the turn. */
export type ScriptTurn = ScriptEntry[];

export type ToolResultEntry = { tool: AgentToolCall['tool']; result: AgentToolResult };

/** What the scripted agent served, and the results the runtime passed back after it. */
export interface AgentStepRecord {
  agent: AgentName;
  /** 1-based, per agent. */
  turn: number;
  /** 1-based, within the turn; a retry is a step of its own. */
  step: number;
  calls?: AgentToolCall[];
  confidence?: number;
  /** A scripted invalid output, returned as is. */
  output?: unknown;
  /** A scripted provider failure. */
  error?: string;
  /** The tool results that came back in the next step's `toolResults`. */
  results: ToolResultEntry[];
}

/**
 * A turn as the runtime reports it: the argument of WP-90's optional `AgentDeps.onTurnEnd`, called
 * once per turn that ran, after its `agent_turn` row is final. `results[i]` answers `calls[i]`;
 * `null` means the call never ran (a refusal earlier in the step, or low confidence).
 */
export interface AgentTurnReport {
  agent: AgentName;
  businessId: string;
  turnId: string;
  /** Null when the turn ended without a stop reason (an unexpected error), as in WP-90's `TurnEnd`. */
  stopReason: AgentTurnStopReason | null;
  steps: { calls: AgentToolCall[]; results: (AgentToolResult | null)[] }[];
}

// Builder

const DEFAULT_CONFIDENCE = 0.9;

/** A step of these calls with confidence 0.9; checked against `AgentStep` when the script is written. */
export function step(...calls: AgentToolCall[]): ScriptEntry {
  return stepWith(DEFAULT_CONFIDENCE, ...calls);
}

/** A step with its own confidence, for the low-confidence limit. */
export function stepWith(confidence: number, ...calls: AgentToolCall[]): ScriptEntry {
  return { kind: 'step', step: AgentStep.parse({ calls, confidence }) };
}

/** A step built from the context of the call it answers; checked against `AgentStep` when it is served. */
export function stepFrom(build: (context: AgentContext) => AgentStep): ScriptEntry {
  return { kind: 'from', build };
}

/** Raw output that fails the task schema, for the model layer's validation and retry. */
export function invalidOutput(output: unknown): ScriptEntry {
  return { kind: 'invalid', output };
}

/** A provider failure (timeout, quota) thrown by this call. */
export function providerFailure(message = 'Simulated model failure'): ScriptEntry {
  return { kind: 'error', error: new Error(message) };
}

type Of<T extends AgentToolCall['tool']> = Extract<AgentToolCall, { tool: T }>;
type Fields<T extends AgentToolCall['tool']> = Omit<Of<T>, 'tool'>;

/** Tool calls with defaults for the optional fields. Each is checked when it goes into a `step`. */
export const call = {
  askOwner: (text: string, options: Partial<Omit<Fields<'ask_owner'>, 'text'>> = {}): Of<'ask_owner'> => ({
    tool: 'ask_owner',
    text,
    topic: options.topic ?? 'info',
    expects: options.expects ?? 'answer',
    ...(options.fields ? { fields: options.fields } : {}),
  }),
  setProfileField: (field: Fields<'set_profile_field'>['field'], value: unknown, sourceQuote?: string): Of<'set_profile_field'> => ({
    tool: 'set_profile_field',
    field,
    value,
    ...(sourceQuote === undefined ? {} : { sourceQuote }),
  }),
  recordFact: (fields: Fields<'record_fact'>): Of<'record_fact'> => ({ tool: 'record_fact', ...fields }),
  requestPhoto: (purpose: Fields<'request_photo'>['purpose'], text: string, postId?: string): Of<'request_photo'> => ({
    tool: 'request_photo',
    purpose,
    text,
    ...(postId === undefined ? {} : { postId }),
  }),
  recordDecline: (what: string, ownerQuote: string, postId?: string): Of<'record_decline'> => ({
    tool: 'record_decline',
    what,
    ownerQuote,
    ...(postId === undefined ? {} : { postId }),
  }),
  planPosts: (fields: Fields<'plan_posts'>): Of<'plan_posts'> => ({ tool: 'plan_posts', ...fields }),
  createDraft: (fields: Fields<'create_draft'>): Of<'create_draft'> => ({ tool: 'create_draft', ...fields }),
  applyChange: (fields: Fields<'apply_change'>): Of<'apply_change'> => ({ tool: 'apply_change', ...fields }),
  handOff: (reason: Fields<'hand_off_to_console'>['reason'], note: string): Of<'hand_off_to_console'> => ({
    tool: 'hand_off_to_console',
    reason,
    note,
  }),
  endTurn: (): Of<'end_turn'> => ({ tool: 'end_turn' }),
};

// Player

interface AgentState {
  turns: ScriptTurn[];
  /** Index of the turn being played; -1 before the first call. */
  turn: number;
  /** Next entry of the current turn. */
  next: number;
  /** The last entry served was an invalid output or a failure, so the next call is its retry. */
  retrying: boolean;
  /** How many of the turn's tool results were already attached to a step. */
  resultsSeen: number;
  last?: AgentStepRecord;
}

/** Plays per-agent scripts and records what it served. Used by `ModelSimulator.scriptAgent`. */
export class ScriptedAgent {
  readonly steps: AgentStepRecord[] = [];
  readonly violations: string[] = [];
  private readonly agents = new Map<AgentName, AgentState>();

  /** Strict: every agent call needs a script, even before (or without) any `script(...)`. */
  constructor(private readonly strict = false) {}

  /** Appends turns to an agent's script. */
  script(agent: AgentName, turns: ScriptTurn[]): void {
    const state = this.agents.get(agent);
    if (state) state.turns.push(...turns);
    else this.agents.set(agent, { turns: [...turns], turn: -1, next: 0, retrying: false, resultsSeen: 0 });
  }

  /** True once the test scripted any agent: from then on, a call to an unscripted agent is a violation. */
  get active(): boolean {
    return this.strict || this.agents.size > 0;
  }

  has(agent: AgentName): boolean {
    return this.agents.has(agent);
  }

  /** The output for one call of an agent task, or a thrown error (scripted or a violation). */
  respond(agent: AgentName, input: unknown): unknown {
    const parsed = AgentContext.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return this.fail(`agent_${agent} got an input that is not an AgentContext (${issues})`);
    }
    const state = this.agents.get(agent);
    if (!state) return this.fail(`agent_${agent} was called, but the test has no script for the ${agent} agent`);

    const toolResults = parsed.data.toolResults;
    if (toolResults.length === 0 && !state.retrying) {
      const left = state.turn >= 0 ? (state.turns[state.turn]?.length ?? 0) - state.next : 0;
      if (left > 0) this.violations.push(`${agent} turn ${state.turn + 1} ended with ${left} unused step(s)`);
      state.turn += 1;
      state.next = 0;
      state.resultsSeen = 0;
      delete state.last;
    } else if (toolResults.length > 0) {
      if (state.turn < 0) return this.fail(`agent_${agent} continued a turn, but no turn started (tool results without a first step)`);
      const fresh = toolResults.slice(state.resultsSeen);
      state.resultsSeen = toolResults.length;
      state.last?.results.push(...fresh);
    }

    const turn = state.turns[state.turn];
    const scripted = turn?.[state.next];
    const entry: ScriptEntry | undefined = scripted?.kind === 'from' ? { kind: 'step', step: AgentStep.parse(scripted.build(parsed.data)) } : scripted;
    if (!entry) {
      return this.fail(
        turn
          ? `the ${agent} script ran out: turn ${state.turn + 1} has no step ${state.next + 1}`
          : `the ${agent} script ran out: there is no turn ${state.turn + 1}`,
      );
    }
    state.next += 1;
    state.retrying = entry.kind !== 'step';

    const record: AgentStepRecord = { agent, turn: state.turn + 1, step: state.next, results: [] };
    if (entry.kind === 'step') Object.assign(record, { calls: structuredClone(entry.step.calls), confidence: entry.step.confidence });
    if (entry.kind === 'invalid') record.output = structuredClone(entry.output);
    if (entry.kind === 'error') record.error = entry.error.message;
    this.steps.push(record);
    state.last = record;

    if (entry.kind === 'error') throw entry.error;
    return entry.kind === 'step' ? structuredClone(entry.step) : structuredClone(entry.output);
  }

  /** Violations so far, then the scripted steps never played. Empty means the scripts ran exactly. */
  problems(): string[] {
    const unused: string[] = [];
    for (const [agent, state] of this.agents) {
      const current = state.turn >= 0 ? (state.turns[state.turn]?.length ?? 0) - state.next : 0;
      const later = state.turns.slice(state.turn + 1);
      const count = Math.max(0, current) + later.reduce((n, t) => n + t.length, 0);
      if (count > 0) {
        const from = state.turn >= 0 && current > 0 ? state.turn + 1 : state.turn + 2;
        unused.push(`${agent}: ${count} unused step(s) never played (turns ${from} to ${state.turns.length})`);
      }
    }
    return [...this.violations, ...unused];
  }

  private fail(message: string): never {
    this.violations.push(message);
    throw new ScriptedAgentError(message);
  }
}
