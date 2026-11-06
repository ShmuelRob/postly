// Agent: the hybrid agent's runtime and tool framework (agent.md). The workflow module calls
// `runTurn`; the agent module never imports workflow (agent.md, Module direction).
// Public surface of the module: other code imports only from this file (see ../README.md).

export { createAgent, type Agent } from './runtime.js';
export { CONTEXT_DAYS, CONTEXT_MESSAGES } from './context.js';
export { handOffLine } from './copy.js';
export type { DraftOutcome } from './tools/drafts.js';
export type { AgentDefinition, AgentDeps, AgentEvents, AgentLimits, AgentTask, RunTurnOptions, ToolHandler, TurnEnd, TurnResult, TurnTrigger } from './types.js';
