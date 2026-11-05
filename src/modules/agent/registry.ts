import type { AgentToolName } from '../../contracts/agent.js';
import { draftsTools } from './tools/drafts.js';
import { factsTools } from './tools/facts.js';
import { planTools } from './tools/plan.js';
import { profileTools } from './tools/profile.js';
import { sharedTools } from './tools/shared.js';
import type { ToolHandler, ToolHandlers } from './types.js';

// The tool registry (agent.md, Tools): one file per tool group. Each agent package fills its own
// group file; this file does not change (docs/implementation-plan.md, Phase 7: File ownership).
const groups: ToolHandlers[] = [sharedTools, profileTools, factsTools, planTools, draftsTools];

export const toolHandlers: ToolHandlers = Object.assign({}, ...groups);

/** The handler for a tool, or undefined while its package has not landed. */
export function handlerFor(tool: AgentToolName): ToolHandler | undefined {
  return toolHandlers[tool] as ToolHandler | undefined;
}
