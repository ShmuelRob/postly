import {
  type CancelSubscriptionResult,
  CreatePaymentLinkRequest,
  type PaymentLink,
  type PaymentProvider,
  type SubscriptionStatusResult,
} from '../contracts/providers/payment.js';
import type { SubscriptionState } from '../contracts/state-machines/index.js';

interface Subscription {
  customerId: string;
  status: SubscriptionState;
  currentPeriodEnd?: string;
  cancelledAt?: string;
}

export interface PaymentSimulatorOptions {
  now?: () => Date;
}

/** In-memory payment provider. Payment happens "on the provider's page": tests call completePayment. */
export class PaymentSimulator implements PaymentProvider {
  readonly name = 'simulator';
  readonly links: { request: CreatePaymentLinkRequest; link: PaymentLink }[] = [];

  private readonly now: () => Date;
  private readonly subscriptions = new Map<string, Subscription>();
  private nextId = 1;

  constructor(options: PaymentSimulatorOptions = {}) {
    this.now = options.now ?? (() => new Date());
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

  /** The owner pays on the provider's page; returns the new provider subscription id. */
  completePayment(
    providerCustomerId: string,
    options: { status?: SubscriptionState; currentPeriodEnd?: string } = {},
  ): string {
    if (!this.links.some((l) => l.link.providerCustomerId === providerCustomerId)) {
      throw new Error(`Unknown provider customer id: ${providerCustomerId}`);
    }
    const id = `sub-sim-${this.nextId++}`;
    this.subscriptions.set(id, {
      customerId: providerCustomerId,
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

  private subscription(id: string): Subscription {
    const subscription = this.subscriptions.get(id);
    if (!subscription) throw new Error(`Unknown provider subscription id: ${id}`);
    return subscription;
  }
}
