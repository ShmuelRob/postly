import { ModelSimulator } from '../model.js';
import { playgroundAgent } from './agent.js';
import { playgroundExtraction } from './extraction.js';
import { playgroundIntent } from './intent.js';
import { playgroundPlanning } from './weekly.js';

// Word-rule stand-ins for the model tasks a human plays through in free Hebrew: the local playground
// (WP-45) and local runs on the model simulator (WP-51; deployed environments run on Vertex AI). Not product
// logic; the real extraction, classification and planning are the model's.
export { playgroundAgent, playgroundExtraction, playgroundIntent, playgroundPlanning };

/** A model simulator that answers free Hebrew well enough to play onboarding, drafts and approval. */
export function conversationalModelSimulator(): ModelSimulator {
  const model = new ModelSimulator();
  model.setDefault('profile_extraction', playgroundExtraction);
  model.setDefault('intent_detection', playgroundIntent);
  model.setDefault('weekly_planning', (input) => playgroundPlanning(input) as never);
  // The agent flows (agent.md): a rule agent per agent task, unless a test scripts that agent.
  model.setDefault('agent_onboarding', playgroundAgent);
  model.setDefault('agent_weekly', playgroundAgent);
  model.setDefault('agent_drafts', playgroundAgent);
  return model;
}
