import type { AgentDefinition } from '../types.js';

// The weekly agent (agent.md, Agents). A stub until WP-93: only the shared tools, and never "done",
// so the turn ends only by a tool or a limit. WP-93 adds its tools, its done rule and its prompt.
export const weeklyAgent: AgentDefinition = {
  name: 'weekly',
  task: 'agent_weekly',
  tools: ['ask_owner', 'request_photo', 'record_decline', 'hand_off_to_console', 'end_turn'],
  doneRule: 'Not available yet: hand off to the console.',
  isDone: async () => false,
};
