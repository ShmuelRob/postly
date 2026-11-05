import type { AgentDefinition } from '../types.js';

// The drafts agent (agent.md, Agents). A stub until WP-94: only the shared tools, and never "done",
// so the turn ends only by a tool or a limit. WP-94 adds its tools, its done rule and its prompt.
export const draftsAgent: AgentDefinition = {
  name: 'drafts',
  task: 'agent_drafts',
  tools: ['ask_owner', 'request_photo', 'record_decline', 'hand_off_to_console', 'end_turn'],
  doneRule: 'Not available yet: hand off to the console.',
  isDone: async () => false,
};
