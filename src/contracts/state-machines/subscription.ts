import { defineMachine } from '../../shared/state-machine.js';

export const SUBSCRIPTION_STATES = ['trialing', 'active', 'past_due', 'cancelled'] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

export const subscriptionMachine = defineMachine({
  name: 'subscription',
  states: SUBSCRIPTION_STATES,
  events: ['PAYMENT_SUCCEEDED', 'TRIAL_ENDED', 'PAYMENT_FAILED', 'CANCELLED'],
  initial: 'trialing',
  terminal: ['cancelled'],
  transitions: {
    trialing: { PAYMENT_SUCCEEDED: 'active', TRIAL_ENDED: 'past_due', CANCELLED: 'cancelled' },
    active: { PAYMENT_FAILED: 'past_due', CANCELLED: 'cancelled' },
    past_due: { PAYMENT_SUCCEEDED: 'active', CANCELLED: 'cancelled' },
  },
});
