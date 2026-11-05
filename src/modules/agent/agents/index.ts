import type { AgentName } from '../../../contracts/agent.js';
import type { AgentDefinition } from '../types.js';
import { draftsAgent } from './drafts.js';
import { onboardingAgent } from './onboarding.js';
import { weeklyAgent } from './weekly.js';

// The fixed list of agents (docs/implementation-plan.md, Phase 7: File ownership). Each agent
// package changes only its own file; this list does not change.
export const agents: Record<AgentName, AgentDefinition> = {
  onboarding: onboardingAgent,
  weekly: weeklyAgent,
  drafts: draftsAgent,
};
