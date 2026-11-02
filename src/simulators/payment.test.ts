import { describe, expect, it } from 'vitest';
import { describePaymentProviderContract } from './contract-suites/payment.js';
import { PaymentSimulator } from './payment.js';

const businessId = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

describePaymentProviderContract('simulator', () => {
  const provider = new PaymentSimulator();
  return {
    provider,
    businessId,
    plan: 'basic',
    createSubscription: async () => {
      const link = await provider.createPaymentLink({ businessId, plan: 'basic' });
      return provider.completePayment(link.providerCustomerId);
    },
  };
});

describe('PaymentSimulator', () => {
  const at = new Date('2026-11-02T10:00:00.000Z');

  it('records links and moves a subscription through scripted states', async () => {
    const sim = new PaymentSimulator({ now: () => at });
    const link = await sim.createPaymentLink({ businessId, plan: 'basic' });
    expect(sim.links).toEqual([{ request: { businessId, plan: 'basic' }, link }]);

    const id = sim.completePayment(link.providerCustomerId, { currentPeriodEnd: '2026-12-02T10:00:00.000Z' });
    expect(await sim.getSubscriptionStatus(id)).toEqual({
      status: 'active',
      currentPeriodEnd: '2026-12-02T10:00:00.000Z',
    });
    sim.setStatus(id, 'past_due');
    expect((await sim.getSubscriptionStatus(id)).status).toBe('past_due');
  });

  it('starts a subscription in trial when scripted', async () => {
    const sim = new PaymentSimulator();
    const link = await sim.createPaymentLink({ businessId, plan: 'basic' });
    const id = sim.completePayment(link.providerCustomerId, { status: 'trialing' });
    expect((await sim.getSubscriptionStatus(id)).status).toBe('trialing');
  });

  it('rejects completing a payment for an unknown customer', () => {
    expect(() => new PaymentSimulator().completePayment('cus_nope')).toThrow();
  });

  it('cancels once; a repeated cancel returns the first time', async () => {
    let now = at;
    const sim = new PaymentSimulator({ now: () => now });
    const link = await sim.createPaymentLink({ businessId, plan: 'basic' });
    const id = sim.completePayment(link.providerCustomerId);
    expect(await sim.cancelSubscription(id)).toEqual({ cancelledAt: '2026-11-02T10:00:00.000Z' });
    now = new Date('2026-11-05T10:00:00.000Z');
    expect(await sim.cancelSubscription(id)).toEqual({ cancelledAt: '2026-11-02T10:00:00.000Z' });
  });
});
