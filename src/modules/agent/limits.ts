import { eq } from 'drizzle-orm';
import type { AgentName } from '../../contracts/agent.js';
import type { Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import type { AgentLimits } from './types.js';

/** The agent's limits from agent_config and the global cap from system_control (agent.md, Limits). */
export async function loadLimits(tx: Tx, agent: AgentName): Promise<AgentLimits> {
  const [config] = await tx.select().from(schema.agentConfig).where(eq(schema.agentConfig.agent, agent));
  if (!config) throw new Error(`No agent_config row for ${agent}`);
  const [control] = await tx.select({ cap: schema.systemControl.agentDailyCostCapUsd }).from(schema.systemControl);
  return {
    maxSteps: config.maxSteps,
    maxToolCalls: config.maxToolCalls,
    maxTurnCostUsd: Number(config.maxTurnCostUsd),
    maxBusinessDailyCostUsd: Number(config.maxBusinessDailyCostUsd),
    // The single system_control row is created on the first global pause; before that the
    // column default applies.
    globalDailyCostUsd: control ? Number(control.cap) : DEFAULT_GLOBAL_DAILY_COST_USD,
    timeoutMs: config.timeoutMs,
    minConfidence: config.minConfidence,
    maxRefusals: config.maxRefusals,
    maxRepeatedQuestions: config.maxRepeatedQuestions,
  };
}

const DAY_MS = 86_400_000;

/** `system_control.agent_daily_cost_cap_usd`'s default (agent.md, A4). */
export const DEFAULT_GLOBAL_DAILY_COST_USD = 50;

/** Local wall-clock parts of `now` in `timeZone`. */
function localParts(now: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  const sinceMidnightMs = ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000 + now.getUTCMilliseconds();
  return { day, sinceMidnightMs };
}

/** The instant of the last local midnight in `timeZone` (the business day of the daily budget). */
export function localMidnight(now: Date, timeZone: string): Date {
  return new Date(now.getTime() - localParts(now, timeZone).sinceMidnightMs);
}

/** The instant the local business week (Sunday 00:00) started; within an hour around a DST change. */
export function localWeekStart(now: Date, timeZone: string): Date {
  const { day } = localParts(now, timeZone);
  return new Date(localMidnight(now, timeZone).getTime() - day * DAY_MS);
}

/** 00:00 UTC of `now`'s day: the global daily cap's day. */
export function utcMidnight(now: Date): Date {
  return new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
}
