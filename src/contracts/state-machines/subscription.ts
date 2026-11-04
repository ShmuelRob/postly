import { defineMachine } from '../../shared/state-machine.js';

/** No trial (T1): `pending` is a payment link sent and nothing paid yet. */
export const SUBSCRIPTION_STATES = ['pending', 'active', 'past_due', 'cancelled'] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

export const subscriptionMachine = defineMachine({
  name: 'subscription',
  states: SUBSCRIPTION_STATES,
  events: ['PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'CANCELLED'],
  initial: 'pending',
  terminal: ['cancelled'],
  transitions: {
    pending: { PAYMENT_SUCCEEDED: 'active', CANCELLED: 'cancelled' },
    active: { PAYMENT_FAILED: 'past_due', CANCELLED: 'cancelled' },
    past_due: { PAYMENT_SUCCEEDED: 'active', CANCELLED: 'cancelled' },
  },
});
