import { describe, expect, it } from 'vitest';
import { describePaymentProviderContract } from './contract-suites/payment.js';
import { PaymentSimulator } from './payment.js';

const businessId = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const price = { amountAgorot: 30000, currency: 'ILS' as const };

describePaymentProviderContract('simulator', () => {
  const provider = new PaymentSimulator();
  return {
    provider,
    businessId,
    plan: 'basic',
    createSubscription: async () => {
      const link = await provider.createPaymentLink({ businessId, plan: 'basic', price });
      return provider.completePayment(link.providerCustomerId);
    },
    webhookFor: async (id) => provider.webhook(id),
  };
});

describe('PaymentSimulator', () => {
  const at = new Date('2026-11-02T10:00:00.000Z');

  it('records links and moves a subscription through scripted states', async () => {
    const sim = new PaymentSimulator({ now: () => at });
    const link = await sim.createPaymentLink({ businessId, plan: 'basic', price });
    expect(sim.links).toEqual([{ request: { businessId, plan: 'basic', price }, link }]);

    const id = sim.completePayment(link.providerCustomerId, { currentPeriodEnd: '2026-12-02T10:00:00.000Z' });
    expect(await sim.getSubscriptionStatus(id)).toEqual({
      status: 'active',
      currentPeriodEnd: '2026-12-02T10:00:00.000Z',
    });
    sim.setStatus(id, 'past_due');
    expect((await sim.getSubscriptionStatus(id)).status).toBe('past_due');
  });

  it('gives each webhook a new event id and reports the latest status', async () => {
    const sim = new PaymentSimulator({ now: () => at });
    const link = await sim.createPaymentLink({ businessId, plan: 'basic', price });
    const id = sim.completePayment(link.providerCustomerId);
    const first = await sim.verifyWebhook(sim.webhook(id));
    sim.setStatus(id, 'past_due');
    const second = await sim.verifyWebhook(sim.webhook(id));
    expect(first).toMatchObject({ businessId, providerCustomerId: link.providerCustomerId, status: 'active' });
    expect(second.status).toBe('past_due');
    expect(second.providerEventId).not.toBe(first.providerEventId);
  });

  it('rejects completing a payment for an unknown customer', () => {
    expect(() => new PaymentSimulator().completePayment('cus_nope')).toThrow();
  });

  it('cancels once; a repeated cancel returns the first time', async () => {
    let now = at;
    const sim = new PaymentSimulator({ now: () => now });
    const link = await sim.createPaymentLink({ businessId, plan: 'basic', price });
    const id = sim.completePayment(link.providerCustomerId);
    expect(await sim.cancelSubscription(id)).toEqual({ cancelledAt: '2026-11-02T10:00:00.000Z' });
    now = new Date('2026-11-05T10:00:00.000Z');
    expect(await sim.cancelSubscription(id)).toEqual({ cancelledAt: '2026-11-02T10:00:00.000Z' });
  });
});

describe('PaymentSimulator price', () => {
  it('records the price it was asked to charge and refuses a missing or non-positive one', async () => {
    const sim = new PaymentSimulator();
    await sim.createPaymentLink({ businessId, plan: 'basic', price });
    expect(sim.links[0]?.request.price).toEqual(price);
    await expect(sim.createPaymentLink({ businessId, plan: 'basic' } as never)).rejects.toThrow();
    await expect(sim.createPaymentLink({ businessId, plan: 'basic', price: { amountAgorot: 0, currency: 'ILS' } })).rejects.toThrow();
  });
});
