import { CONVERSATION_STATES } from './conversation.js';
import { ONBOARDING_STEPS } from './onboarding.js';

export * from './business.js';
export * from './channel-connection.js';
export * from './conversation.js';
export * from './onboarding.js';
export * from './post.js';
export * from './publication.js';
export * from './subscription.js';
export * from './weekly-update.js';

/** Values of the `conversation_step` database enum: onboarding steps, then conversation states. */
export const CONVERSATION_STEP_VALUES = [...ONBOARDING_STEPS, ...CONVERSATION_STATES] as const;
export type ConversationStep = (typeof CONVERSATION_STEP_VALUES)[number];
