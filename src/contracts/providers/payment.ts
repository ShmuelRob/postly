import { z } from 'zod';
import { Timestamp, Url, Uuid } from '../common.js';
import { SUBSCRIPTION_STATES } from '../state-machines/index.js';
import type { WebhookRequest } from './messaging.js';

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

/** A verified provider callback: the subscription's id and its new status. */
export const PaymentEvent = z.object({
  providerEventId: z.string().min(1),
  /** The businessId given to createPaymentLink, echoed back by the provider. */
  businessId: Uuid,
  providerCustomerId: z.string().min(1),
  providerSubscriptionId: z.string().min(1),
  status: z.enum(SUBSCRIPTION_STATES),
  currentPeriodEnd: Timestamp.optional(),
});
export type PaymentEvent = z.infer<typeof PaymentEvent>;

/** Payment happens on the provider's page; Postly stores only identifiers and status. */
export interface PaymentProvider {
  readonly name: string;
  createPaymentLink(request: CreatePaymentLinkRequest): Promise<PaymentLink>;
  getSubscriptionStatus(providerSubscriptionId: string): Promise<SubscriptionStatusResult>;
  cancelSubscription(providerSubscriptionId: string): Promise<CancelSubscriptionResult>;
}

/**
 * The provider's signed status callbacks. Every payment adapter implements it next to
 * PaymentProvider; it is a separate interface so the PaymentProvider stubs in the pinned H5 tests
 * stay valid (contracts.md, PaymentProvider).
 */
export interface PaymentWebhooks {
  /** Throws InvalidWebhookSignatureError when the signature does not verify. */
  verifyWebhook(request: WebhookRequest): Promise<PaymentEvent>;
}
