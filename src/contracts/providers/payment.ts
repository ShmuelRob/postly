import { z } from 'zod';
import { Timestamp, Url, Uuid } from '../common.js';
import { SUBSCRIPTION_STATES } from '../state-machines/index.js';

export const CreatePaymentLinkRequest = z.object({ businessId: Uuid, plan: z.string().min(1) });
export type CreatePaymentLinkRequest = z.infer<typeof CreatePaymentLinkRequest>;

export const PaymentLink = z.object({ url: Url, providerCustomerId: z.string().min(1) });
export type PaymentLink = z.infer<typeof PaymentLink>;

export const SubscriptionStatusResult = z.object({
  status: z.enum(SUBSCRIPTION_STATES),
  currentPeriodEnd: Timestamp.optional(),
});
export type SubscriptionStatusResult = z.infer<typeof SubscriptionStatusResult>;

export const CancelSubscriptionResult = z.object({ cancelledAt: Timestamp });
export type CancelSubscriptionResult = z.infer<typeof CancelSubscriptionResult>;

/** Payment happens on the provider's page; Postly stores only identifiers and status. */
export interface PaymentProvider {
  readonly name: string;
  createPaymentLink(request: CreatePaymentLinkRequest): Promise<PaymentLink>;
  getSubscriptionStatus(providerSubscriptionId: string): Promise<SubscriptionStatusResult>;
  cancelSubscription(providerSubscriptionId: string): Promise<CancelSubscriptionResult>;
}
