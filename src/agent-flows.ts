import { AGENT_NAMES, type AgentName } from './contracts/agent.js';
import type { Database } from './db/index.js';
import * as schema from './db/schema.js';

// Which flows run on the agent, per environment (agent.md, Running on dev): POSTLY_AGENT_FLOWS, set by
// Terraform's `agent_flows`, is written into system_control.agent_flows when the web process starts,
// so the global switch is the reviewed configuration value, never a hand-written SQL edit.

export type AgentFlows = Record<AgentName, boolean>;

/**
 * `onboarding,weekly,drafts` (any subset, comma-separated) or `none`. Every agent gets a value, so
 * the switch is exactly the listed set. Throws on an empty value, an unknown flow, or `none` mixed in.
 */
export function parseAgentFlows(value: string): AgentFlows {
  const names = value.split(',').map((n) => n.trim());
  const fail = (why: string) => new Error(`POSTLY_AGENT_FLOWS ${why}: use onboarding, weekly and drafts comma-separated, or none`);
  if (names.every((n) => n === '')) throw fail('is empty');
  if (names.includes('none')) {
    if (names.length > 1) throw fail('mixes none with flows');
    return Object.fromEntries(AGENT_NAMES.map((a) => [a, false])) as AgentFlows;
  }
  const unknown = names.filter((n) => !(AGENT_NAMES as readonly string[]).includes(n));
  if (unknown.length) throw fail(`names an unknown flow (${unknown.join(', ')})`);
  return Object.fromEntries(AGENT_NAMES.map((a) => [a, names.includes(a)])) as AgentFlows;
}

/**
 * Writes the switch into system_control (creating its single row if needed), as the `console` system
 * purpose that owns that table's writes (database-schema.md). Idempotent; the per-business
 * business.agent_flows still wins over it.
 */
export async function applyAgentFlows(db: Database, flows: AgentFlows): Promise<void> {
  const value = { ...flows };
  await db.withSystem('console', (tx) =>
    tx
      .insert(schema.systemControl)
      .values({ id: 1, agentFlows: value })
      .onConflictDoUpdate({ target: schema.systemControl.id, set: { agentFlows: value, updatedAt: new Date() } }),
  );
}
