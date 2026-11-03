import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidWebhookSignatureError, WebhookRequest } from '../contracts/providers/messaging.js';
import {
  type CancelSubscriptionResult,
  CreatePaymentLinkRequest,
  type PaymentLink,
  PaymentEvent,
  type PaymentProvider,
  type PaymentWebhooks,
  type SubscriptionStatusResult,
} from '../contracts/providers/payment.js';
import type { SubscriptionState } from '../contracts/state-machines/index.js';

export const PAYMENT_SIMULATOR_SIGNATURE_HEADER = 'x-simulator-payment-signature';

interface Subscription {
  customerId: string;
  businessId: string;
  status: SubscriptionState;
  currentPeriodEnd?: string;
  cancelledAt?: string;
}

export interface PaymentSimulatorOptions {
  now?: () => Date;
  webhookSecret?: string;
  webhookUrl?: string;
}

/**
 * In-memory payment provider. Payment happens "on the provider's page": tests call completePayment,
 * then webhook() builds the provider's signed callback (HMAC-SHA256 over the url and body).
 */
export class PaymentSimulator implements PaymentProvider, PaymentWebhooks {
  readonly name = 'simulator';
  readonly links: { request: CreatePaymentLinkRequest; link: PaymentLink }[] = [];

  private readonly now: () => Date;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly secret: string;
  private readonly url: string;
  private nextId = 1;

  constructor(options: PaymentSimulatorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.secret = options.webhookSecret ?? 'simulator-payment-webhook-secret';
    this.url = options.webhookUrl ?? 'https://postly.example.test/webhooks/payment';
  }

  async createPaymentLink(request: CreatePaymentLinkRequest): Promise<PaymentLink> {
    const parsed = CreatePaymentLinkRequest.parse(request);
    const providerCustomerId = `cus-sim-${this.nextId++}`;
    const link = { url: `https://pay.simulator.test/checkout/${providerCustomerId}`, providerCustomerId };
    this.links.push({ request: parsed, link });
    return link;
  }

  async getSubscriptionStatus(providerSubscriptionId: string): Promise<SubscriptionStatusResult> {
    const { status, currentPeriodEnd } = this.subscription(providerSubscriptionId);
    return { status, ...(currentPeriodEnd === undefined ? {} : { currentPeriodEnd }) };
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<CancelSubscriptionResult> {
    const subscription = this.subscription(providerSubscriptionId);
    subscription.cancelledAt ??= this.now().toISOString();
    subscription.status = 'cancelled';
    return { cancelledAt: subscription.cancelledAt };
  }

  async verifyWebhook(request: WebhookRequest): Promise<PaymentEvent> {
    const { headers, body, url } = WebhookRequest.parse(request);
    const signature = Object.entries(headers).find(([k]) => k.toLowerCase() === PAYMENT_SIMULATOR_SIGNATURE_HEADER)?.[1];
    const expected = Buffer.from(this.sign(url, body));
    if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), expected)) {
      throw new InvalidWebhookSignatureError('Simulator payment webhook signature does not verify');
    }
    return PaymentEvent.parse(JSON.parse(body));
  }

  /** The signed callback the provider sends for this subscription's current status. */
  webhook(providerSubscriptionId: string): WebhookRequest {
    const { customerId, businessId, status, currentPeriodEnd } = this.subscription(providerSubscriptionId);
    const event: PaymentEvent = {
      providerEventId: `evt-sim-${this.nextId++}`,
      businessId,
      providerCustomerId: customerId,
      providerSubscriptionId,
      status,
      ...(currentPeriodEnd === undefined ? {} : { currentPeriodEnd }),
    };
    const body = JSON.stringify(event);
    return {
      url: this.url,
      body,
      headers: { 'content-type': 'application/json', [PAYMENT_SIMULATOR_SIGNATURE_HEADER]: this.sign(this.url, body) },
    };
  }

  /** The owner pays on the provider's page; returns the new provider subscription id. */
  completePayment(
    providerCustomerId: string,
    options: { status?: SubscriptionState; currentPeriodEnd?: string } = {},
  ): string {
    const created = this.links.find((l) => l.link.providerCustomerId === providerCustomerId);
    if (!created) throw new Error(`Unknown provider customer id: ${providerCustomerId}`);
    const id = `sub-sim-${this.nextId++}`;
    this.subscriptions.set(id, {
      customerId: providerCustomerId,
      businessId: created.request.businessId,
      status: options.status ?? 'active',
      ...(options.currentPeriodEnd === undefined ? {} : { currentPeriodEnd: options.currentPeriodEnd }),
    });
    return id;
  }

  /** The provider reports a new state (a failed renewal, a recovered payment). */
  setStatus(providerSubscriptionId: string, status: SubscriptionState, currentPeriodEnd?: string): void {
    const subscription = this.subscription(providerSubscriptionId);
    subscription.status = status;
    if (currentPeriodEnd !== undefined) subscription.currentPeriodEnd = currentPeriodEnd;
  }

  private sign(url: string, body: string): string {
    return `sha256=${createHmac('sha256', this.secret).update(url).update(body).digest('hex')}`;
  }

  private subscription(id: string): Subscription {
    const subscription = this.subscriptions.get(id);
    if (!subscription) throw new Error(`Unknown provider subscription id: ${id}`);
    return subscription;
  }
}
