import { defineMachine } from '../../shared/state-machine.js';

export const BUSINESS_STATES = ['onboarding', 'active', 'paused', 'cancelled', 'archived'] as const;
export type BusinessState = (typeof BUSINESS_STATES)[number];

// state-machines.md, Business. Cancellation never deletes data (2026-11-07): a cancelled business is
// archived once `archive_after` passes, and `archived` is the terminal state.
export const businessMachine = defineMachine({
  name: 'business',
  states: BUSINESS_STATES,
  events: ['ONBOARDING_COMPLETED', 'PAUSE', 'RESUME', 'CANCEL', 'ARCHIVE'],
  initial: 'onboarding',
  terminal: ['archived'],
  transitions: {
    onboarding: { ONBOARDING_COMPLETED: 'active', CANCEL: 'cancelled' },
    active: { PAUSE: 'paused', CANCEL: 'cancelled' },
    paused: { RESUME: 'active', CANCEL: 'cancelled' },
    cancelled: { ARCHIVE: 'archived' },
  },
});
