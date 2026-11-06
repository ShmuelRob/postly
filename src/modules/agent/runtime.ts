import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import {
  AgentStep,
  AgentToolCall,
  AgentToolResult,
  type AgentName,
  type AgentToolName,
  type AgentTurnStopReason,
} from '../../contracts/agent.js';
import * as schema from '../../db/schema.js';
import { log } from '../../shared/logger.js';
import { ModelTaskFailedError } from '../model-layer/index.js';
import { agents as defaultAgents } from './agents/index.js';
import { buildContext } from './context.js';
import { handOff } from './handoff.js';
import { loadLimits, localMidnight, localWeekStart, utcMidnight } from './limits.js';
import { handlerFor } from './registry.js';
import type { AgentDeps, AgentLimits, PastCall, ToolContext, ToolOutcome, TurnResult, TurnTrigger } from './types.js';

/** One recorded step of a turn: what the model asked for and what code answered (agent_turn.steps). */
interface RecordedStep {
  confidence: number | null;
  costUsd: number;
  calls: { call: unknown; result: AgentToolResult | null }[];
}

/** Marks a model call cut off by the turn's timeout (agent.md, Limits). */
const TIMED_OUT = Symbol('timed out');

/**
 * The call's answer, or TIMED_OUT once `ms` pass. A model call that hangs must not keep the turn,
 * and with it the business's turn lock, past the timeout: the turn ends and a late answer is
 * dropped (its tools never run; its cost is still recorded by the model layer).
 */
async function withinTime<T>(call: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms))));
  call.catch(() => {}); // a late failure is nobody's to handle
  try {
    return await Promise.race([call, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Dollar amounts are floats; a millionth of a cent is below any real price. */
const EPSILON_USD = 1e-9;

/** Stops that end the turn with a hand-off to the console (agent.md, Limits). */
const LIMIT_STOPS = new Set<AgentTurnStopReason>([
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
]);

export interface Agent {
  /**
   * Runs one turn of one agent for one business (agent.md, Runtime). Called by the workflow module
   * for a routed burst or a code event; returns `skipped` when another turn runs or a person handles
   * the conversation.
   */
  runTurn(businessId: string, agent: AgentName, trigger: TurnTrigger): Promise<TurnResult>;
  /** Whether a flow runs on the agent for this business: business.agent_flows, else system_control. */
  flowEnabled(businessId: string, agent: AgentName): Promise<boolean>;
}

export function createAgent(input: AgentDeps): Agent {
  const { onTurnEnd, agents: _agents, ...rest } = input;
  const deps = { ...rest, now: input.now ?? (() => new Date()) };
  const agents = input.agents ?? defaultAgents;

  /** Successful calls of earlier turns in scope: this onboarding, or this business week. */
  async function pastCalls(businessId: string, agent: AgentName, since: Date): Promise<PastCall[]> {
    const turns = await deps.db.withBusiness('workflow', businessId, (tx) =>
      tx
        .select({ id: schema.agentTurn.id, steps: schema.agentTurn.steps })
        .from(schema.agentTurn)
        .where(and(eq(schema.agentTurn.businessId, businessId), eq(schema.agentTurn.agent, agent), gte(schema.agentTurn.startedAt, since)))
        .orderBy(asc(schema.agentTurn.startedAt)),
    );
    return turns.flatMap((t) => callsOf(t.id, t.steps as RecordedStep[]));
  }

  return {
    async flowEnabled(businessId, agent) {
      return deps.db.withBusiness('workflow', businessId, async (tx) => {
        const [business] = await tx.select({ flows: schema.business.agentFlows }).from(schema.business).where(eq(schema.business.id, businessId));
        const own = (business?.flows ?? {}) as Partial<Record<AgentName, boolean>>;
        if (typeof own[agent] === 'boolean') return own[agent];
        const [control] = await tx.select({ flows: schema.systemControl.agentFlows }).from(schema.systemControl);
        return ((control?.flows ?? {}) as Partial<Record<AgentName, boolean>>)[agent] === true;
      });
    },

    async runTurn(businessId, agentName, trigger) {
      const definition = agents[agentName];
      const started = deps.now();

      // 1. Lock: one turn per business, under the conversation_state row lock.
      const opened = await deps.db.withBusiness('workflow', businessId, async (tx) => {
        const limits = await loadLimits(tx, agentName);
        const [conversation] = await tx
          .select({ handoffAt: schema.conversationState.handoffAt })
          .from(schema.conversationState)
          .where(eq(schema.conversationState.businessId, businessId))
          .for('update');
        if (!conversation || conversation.handoffAt) return { limits, turnId: null };
        const t = schema.agentTurn;
        const staleBefore = new Date(started.getTime() - 2 * limits.timeoutMs);
        const running = await tx
          .select({ id: t.id, startedAt: t.startedAt })
          .from(t)
          .where(and(eq(t.businessId, businessId), eq(t.status, 'running')));
        if (running.some((r) => r.startedAt >= staleBefore)) return { limits, turnId: null };
        // A running turn older than twice the timeout crashed: close it as failed.
        if (running.length > 0) {
          await tx
            .update(t)
            .set({ status: 'failed', endedAt: started })
            .where(and(eq(t.businessId, businessId), eq(t.status, 'running'), lt(t.startedAt, staleBefore), inArray(t.id, running.map((r) => r.id))));
        }
        const [turn] = await tx.insert(t).values({ businessId, agent: agentName, trigger, startedAt: started }).returning({ id: t.id });
        return { limits, turnId: turn!.id };
      });
      if (!opened.turnId) return { turnId: null, status: 'skipped', stopReason: null };
      const { limits, turnId } = opened;

      const steps: RecordedStep[] = [];
      const save = () =>
        deps.db.withBusiness('workflow', businessId, (tx) =>
          tx.update(schema.agentTurn).set({ steps }).where(and(eq(schema.agentTurn.businessId, businessId), eq(schema.agentTurn.id, turnId))),
        );

      let stop: AgentTurnStopReason | null = null;
      let approverPhone = '';
      let personaName = '';
      let language: Parameters<typeof handOff>[1]['language'] = 'he';
      let failed: unknown = null;
      try {
        const first = await deps.db.withBusiness('workflow', businessId, (tx) =>
          buildContext(tx, { businessId, agent: definition, now: started, history: [], budget: { stepsLeft: limits.maxSteps, costLeftUsd: limits.maxTurnCostUsd }, toolResults: [] }),
        );
        approverPhone = first.approverPhone;
        personaName = first.personaName;
        language = first.context.languages[0] ?? 'he';
        const scope = agentName === 'onboarding' ? new Date(0) : localWeekStart(started, first.timezone);
        const history = await pastCalls(businessId, agentName, scope);
        const turn = { messagesSent: 0, questionsAsked: 0 };
        const toolResults: { tool: AgentToolName; result: AgentToolResult }[] = [];
        const stepCap = await deps.models.costCap(businessId, definition.task);
        let toolCalls = 0;
        let refusals = 0;

        while (stop === null) {
          const now = deps.now();
          if (steps.length >= limits.maxSteps) stop = 'max_steps';
          else if (now.getTime() - started.getTime() >= limits.timeoutMs) stop = 'timeout';
          if (stop) break;

          // Budgets, checked before each step against the step's full cap (agent.md, Limits).
          const turnSpent = await deps.models.spentOnTurn(businessId, turnId);
          const turnLeft = limits.maxTurnCostUsd - turnSpent;
          if (turnLeft + EPSILON_USD < stepCap) {
            stop = 'turn_budget';
            break;
          }
          if ((await deps.models.spentSince(businessId, localMidnight(now, first.timezone))) + stepCap > limits.maxBusinessDailyCostUsd + EPSILON_USD) {
            stop = 'daily_budget';
            break;
          }
          const spentByAll = await deps.models.spentByAllSince(utcMidnight(now));
          if (spentByAll + stepCap > limits.globalDailyCostUsd + EPSILON_USD) {
            stop = 'global_budget';
            // The team's alert (agent.md, Limits; docs/observability.md, Alerts): one line per stopped turn.
            log.warn('agent global budget reached', { businessId, agent: agentName, agentTurnId: turnId, capUsd: limits.globalDailyCostUsd, spentUsd: spentByAll });
            break;
          }

          const { context } = await deps.db.withBusiness('workflow', businessId, (tx) =>
            buildContext(tx, {
              businessId,
              agent: definition,
              now,
              history,
              budget: { stepsLeft: limits.maxSteps - steps.length, costLeftUsd: Math.max(0, turnLeft) },
              toolResults,
            }),
          );

          let step: AgentStep;
          try {
            const left = limits.timeoutMs - (deps.now().getTime() - started.getTime());
            const answer = await withinTime(
              deps.models.run(businessId, definition.task, context, { maxCostUsd: stepCap, agentTurnId: turnId, referenceId: turnId }),
              left,
            );
            if (answer === TIMED_OUT) {
              stop = 'timeout';
              break;
            }
            step = answer;
          } catch (error) {
            if (!(error instanceof ModelTaskFailedError)) throw error;
            steps.push({ confidence: null, costUsd: (await deps.models.spentOnTurn(businessId, turnId)) - turnSpent, calls: [] });
            stop = 'invalid_output';
            break;
          }
          const recorded: RecordedStep = { confidence: step.confidence, costUsd: (await deps.models.spentOnTurn(businessId, turnId)) - turnSpent, calls: [] };
          steps.push(recorded);
          if (step.confidence < limits.minConfidence) {
            recorded.calls = step.calls.map((call) => ({ call, result: null }));
            await save();
            stop = 'low_confidence';
            break;
          }

          const ctx: ToolContext = { businessId, turnId, agent: agentName, deps, context, approverPhone, personaName, limits, history, turn };
          for (const call of step.calls) {
            if (toolCalls >= limits.maxToolCalls) {
              stop = 'max_tool_calls';
              break;
            }
            toolCalls += 1;
            const outcome = await runTool(call, definition.tools, ctx);
            recorded.calls.push({ call, result: outcome.result });
            toolResults.push({ tool: call.tool, result: outcome.result });
            if (outcome.result.status === 'ok') history.push({ turnId, call, result: outcome.result });
            await save();
            if (outcome.stop) {
              stop = outcome.stop;
              break;
            }
            if (outcome.result.status === 'refused') {
              refusals += 1;
              if (refusals >= limits.maxRefusals) stop = 'refusals';
              // A refused call stops the step: its later calls are skipped (agent.md, Runtime).
              break;
            }
            // The turn stops after the current tool call once its time is up (agent.md, Limits).
            if (deps.now().getTime() - started.getTime() >= limits.timeoutMs) {
              stop = 'timeout';
              break;
            }
          }
          if (stop === null && (await definition.isDone({ businessId, db: deps.db, turnId }))) stop = 'done';
        }
      } catch (error) {
        failed = error;
        log.error('agent turn failed', { businessId, agentTurnId: turnId, error: error instanceof Error ? error : String(error) });
      }

      const ended = deps.now();
      if (failed === null && stop !== null && LIMIT_STOPS.has(stop)) {
        await handOff(deps, { businessId, turnId, kind: 'agent_limit', details: { reason: stop, agent: agentName }, approverPhone, personaName, language, now: ended });
      } else if (failed !== null) {
        // An unexpected error still leaves the conversation with a person, never silent.
        await handOff(deps, { businessId, turnId, kind: 'agent_limit', details: { reason: 'error', agent: agentName, error: String(failed) }, approverPhone, personaName, language, now: ended }).catch(
          (error: unknown) => log.error('agent hand-off failed', { businessId, agentTurnId: turnId, error: String(error) }),
        );
      }
      const status: TurnResult['status'] =
        failed !== null ? 'failed' : stop === 'waiting_for_owner' ? 'waiting' : stop === 'done' || stop === 'end_turn' ? 'done' : 'handed_off';
      const costUsd = await deps.models.spentOnTurn(businessId, turnId).catch(() => 0);
      await deps.db.withBusiness('workflow', businessId, (tx) =>
        tx
          .update(schema.agentTurn)
          .set({ status, stopReason: stop, steps, costUsd: costUsd.toFixed(6), durationMs: ended.getTime() - started.getTime(), endedAt: ended })
          .where(and(eq(schema.agentTurn.businessId, businessId), eq(schema.agentTurn.id, turnId))),
      );
      if (onTurnEnd) {
        await onTurnEnd({
          agent: agentName,
          businessId,
          turnId,
          stopReason: stop,
          steps: steps.map((s) => ({ calls: s.calls.map((c) => c.call as AgentToolCall), results: s.calls.map((c) => c.result) })),
        });
      }
      return { turnId, status, stopReason: stop };
    },
  };
}

/** Runs one call: allowed for this agent, a handler exists, then the handler's own checks. */
async function runTool(call: AgentToolCall, allowed: readonly AgentToolName[], ctx: ToolContext): Promise<ToolOutcome> {
  const handler = handlerFor(call.tool);
  if (!allowed.includes(call.tool) || !handler) {
    return { result: { status: 'refused', reason: 'not_allowed', detail: `${call.tool} is not available to the ${ctx.agent} agent now` } };
  }
  return handler(call as never, ctx);
}

/** The successful calls recorded in one turn's steps. */
function callsOf(turnId: string, steps: RecordedStep[]): PastCall[] {
  return steps.flatMap((s) =>
    s.calls.flatMap(({ call, result }) => {
      const c = AgentToolCall.safeParse(call);
      const r = AgentToolResult.safeParse(result);
      return c.success && r.success && r.data.status === 'ok' ? [{ turnId, call: c.data, result: r.data }] : [];
    }),
  );
}

export type { AgentLimits };
