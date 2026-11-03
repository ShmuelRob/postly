import { describe, expect, it } from 'vitest';
import { listTransitions } from '../../shared/state-machine.js';
import { subscriptionMachine } from '../../contracts/state-machines/index.js';
import { eventFor } from './billing.js';

describe('eventFor', () => {
  it('finds the machine event for every transition in state-machines.md, Subscription', () => {
    for (const [from, event, to] of listTransitions(subscriptionMachine)) {
      expect(eventFor(from, to)).toBe(event);
    }
  });

  it('finds none out of a terminal state or back into trialing', () => {
    expect(eventFor('cancelled', 'active')).toBeNull();
    expect(eventFor('active', 'trialing')).toBeNull();
    expect(eventFor('past_due', 'trialing')).toBeNull();
  });
});
