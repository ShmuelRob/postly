import { beforeEach, describe, expect, it } from 'vitest';
import {
  CancelSubscriptionResult,
  PaymentEvent,
  PaymentLink,
  type PaymentProvider,
  type PaymentWebhooks,
  SubscriptionStatusResult,
} from '../../contracts/providers/payment.js';
import { InvalidWebhookSignatureError, type WebhookRequest } from '../../contracts/providers/messaging.js';

export interface PaymentContractContext {
  provider: PaymentProvider & PaymentWebhooks;
  businessId: string;
  plan: string;
  /**
   * Returns the id of a live (not cancelled) subscription. The interface has no
   * way to learn it, so the simulator or the vendor's test mode provides one.
   */
  createSubscription(): Promise<string>;
  /** The provider's signed callback reporting this subscription's current status (vendor test mode for a real adapter). */
  webhookFor(providerSubscriptionId: string): Promise<WebhookRequest>;
}

/** The behavior every PaymentProvider must share; a real adapter runs it once the vendor is chosen. */
export function describePaymentProviderContract(
  label: string,
  makeContext: () => PaymentContractContext | Promise<PaymentContractContext>,
): void {
  describe(`PaymentProvider contract: ${label}`, () => {
    let ctx: PaymentContractContext;
    beforeEach(async () => {
      ctx = await makeContext();
    });

    it('has a name', () => {
      expect(ctx.provider.name.length).toBeGreaterThan(0);
    });

    it('creates a payment link', async () => {
      const link = await ctx.provider.createPaymentLink({ businessId: ctx.businessId, plan: ctx.plan });
      expect(PaymentLink.safeParse(link).success).toBe(true);
    });

    it('rejects a request outside the contract shape', async () => {
      await expect(ctx.provider.createPaymentLink({ businessId: 'not-a-uuid', plan: ctx.plan })).rejects.toThrow();
    });

    it('reports a live subscription in a subscription state', async () => {
      const status = await ctx.provider.getSubscriptionStatus(await ctx.createSubscription());
      expect(SubscriptionStatusResult.parse(status).status).not.toBe('cancelled');
    });

    it('cancels a subscription, after which it reports cancelled', async () => {
      const id = await ctx.createSubscription();
      const result = await ctx.provider.cancelSubscription(id);
      expect(CancelSubscriptionResult.safeParse(result).success).toBe(true);
      expect((await ctx.provider.getSubscriptionStatus(id)).status).toBe('cancelled');
    });

    it('verifies a signed webhook into the event that names the subscription and its business', async () => {
      const id = await ctx.createSubscription();
      const event = PaymentEvent.parse(await ctx.provider.verifyWebhook(await ctx.webhookFor(id)));
      expect(event).toMatchObject({ providerSubscriptionId: id, businessId: ctx.businessId });
      expect(event.status).toBe((await ctx.provider.getSubscriptionStatus(id)).status);
    });

    it('rejects a webhook whose body was changed after signing', async () => {
      const hook = await ctx.webhookFor(await ctx.createSubscription());
      const tampered = { ...hook, body: hook.body.replace(/"status":"[a-z_]+"/, '"status":"cancelled"') + ' ' };
      await expect(ctx.provider.verifyWebhook(tampered)).rejects.toThrow(InvalidWebhookSignatureError);
    });

    it('rejects an unknown subscription id', async () => {
      await expect(ctx.provider.getSubscriptionStatus('no-such-subscription')).rejects.toThrow();
    });
  });
}
