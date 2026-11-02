import { defineMachine } from '../../shared/state-machine.js';

export const BUSINESS_STATES = ['onboarding', 'active', 'paused', 'cancelled'] as const;
export type BusinessState = (typeof BUSINESS_STATES)[number];

export const businessMachine = defineMachine({
  name: 'business',
  states: BUSINESS_STATES,
  events: ['ONBOARDING_COMPLETED', 'PAUSE', 'RESUME', 'CANCEL'],
  initial: 'onboarding',
  terminal: ['cancelled'],
  transitions: {
    onboarding: { ONBOARDING_COMPLETED: 'active', CANCEL: 'cancelled' },
    active: { PAUSE: 'paused', CANCEL: 'cancelled' },
    paused: { RESUME: 'active', CANCEL: 'cancelled' },
  },
});
