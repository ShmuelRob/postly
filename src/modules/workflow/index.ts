// Workflow: state machines for onboarding, conversation, and posts.
// Public surface of the module: other code imports only from this file (see ../README.md).

export type { MachineName } from './machines.js';
export {
  consoleLogger,
  createWorkflow,
  type EventRequest,
  type EventResult,
  type EventSource,
  type Guard,
  type RejectionLog,
  type Workflow,
  type WorkflowLogger,
} from './workflow.js';
export {
  createOnboarding,
  MAX_QUESTION_ATTEMPTS,
  mergeDraft,
  parseStyle,
  PROFILE_QUESTIONS,
  type Onboarding,
  type OnboardingBurst,
  type OnboardingDeps,
} from './onboarding.js';
export * as onboardingCopy from './onboarding-copy.js';
