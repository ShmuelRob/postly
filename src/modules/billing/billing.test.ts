import { describe, expect, it } from 'vitest';
import { listTransitions } from '../../shared/state-machine.js';
import { subscriptionMachine } from '../../contracts/state-machines/index.js';
import { BILLING_COPY, eventFor } from './billing.js';

describe('eventFor', () => {
  it('finds the machine event for every transition in state-machines.md, Subscription', () => {
    for (const [from, event, to] of listTransitions(subscriptionMachine)) {
      expect(eventFor(from, to)).toBe(event);
    }
  });

  it('finds none out of a terminal state or back into pending', () => {
    expect(eventFor('cancelled', 'active')).toBeNull();
    expect(eventFor('active', 'pending')).toBeNull();
    expect(eventFor('past_due', 'pending')).toBeNull();
  });

  it('never moves an unpaid subscription to past_due (no trial)', () => {
    expect(eventFor('pending', 'past_due')).toBeNull();
  });
});

describe('BILLING_COPY.paymentLink', () => {
  it('states the price in shekels', () => {
    expect(BILLING_COPY.paymentLink('https://pay.example.test/x', 30000)).toContain('300 ₪ לחודש');
    expect(BILLING_COPY.paymentLink('https://pay.example.test/x', 29950)).toContain('299.50 ₪ לחודש');
  });
});
