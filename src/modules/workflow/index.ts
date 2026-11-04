// Workflow: state machines for onboarding, the weekly update, conversation, and posts.
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
export { createWeeklyUpdates, type WeeklyDeps, type WeeklyUpdates } from './weekly.js';
export { localWeek, type LocalWeek } from './week.js';
export * as weeklyCopy from './weekly-copy.js';
export { createDrafts, networksFromChange, parsePhotoChoice, type Drafts, type DraftsBurst, type DraftsDeps, type PhotoChoice } from './drafts.js';
export * as draftsCopy from './drafts-copy.js';
export { createApprovals, type Approvals, type ApprovalsDeps, type StoredTap } from './approvals.js';
