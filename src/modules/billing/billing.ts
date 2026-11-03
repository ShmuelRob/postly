import { eq } from 'drizzle-orm';
import { WindowClosedError, type WebhookRequest } from '../../contracts/providers/messaging.js';
import type { PaymentEvent, PaymentProvider, PaymentWebhooks } from '../../contracts/providers/payment.js';
import { subscriptionMachine, type SubscriptionState } from '../../contracts/state-machines/index.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { canTransition, transition } from '../../shared/state-machine.js';
import type { Messaging } from '../messaging/index.js';

type SubscriptionEvent = (typeof subscriptionMachine.events)[number];

/** PRD, Payment: a single plan for now. */
export const DEFAULT_PLAN = 'basic';

/** Owner-facing copy. Provisional (H6): drafted from the PRD and queued for the human. */
export const BILLING_COPY = {
  paymentLink: (url: string) =>
    `כדי להפעיל את המנוי ל-Postly, אפשר לשלם בקישור המאובטח:\n${url}\nהתשלום מתבצע באתר של ספק התשלום, ואנחנו לא שומרים את פרטי הכרטיס.`,
  active: 'התשלום התקבל והמנוי פעיל. תודה!',
  past_due: 'לא הצלחנו לגבות את התשלום על המנוי. כדי שהשירות ימשיך, כתבו לנו כאן ונעזור לעדכן את אמצעי התשלום.',
  cancelled: 'המנוי בוטל.',
} as const;

export type WebhookOutcome =
  /** The status changed; `notified` is false when the 24-hour window was closed. */
  | { kind: 'applied'; from: SubscriptionState; to: SubscriptionState; notified: boolean }
  /** The provider's current status equals the stored one (a stale, replayed or parallel callback): nothing changes, nothing is sent. */
  | { kind: 'unchanged'; status: SubscriptionState }
  /** No transition from the stored status to the reported one (state-machines.md, Subscription). */
  | { kind: 'rejected'; from: SubscriptionState; reported: SubscriptionState }
  /** No subscription for this business, or its provider customer id does not match. */
  | { kind: 'unknown_subscription' };

export interface BillingOptions {
  db: Database;
  messaging: Messaging;
  provider: PaymentProvider & PaymentWebhooks;
  plan?: string;
}

export interface Billing {
  /** Creates the payment link, stores the subscription row, and sends the link to the approver in WhatsApp. */
  sendPaymentLink(businessId: string): Promise<{ url: string }>;
  /** Verifies the provider's callback, then applies the provider's current status; throws InvalidWebhookSignatureError when it does not verify. */
  handleWebhook(request: WebhookRequest): Promise<WebhookOutcome>;
}

const EVENTS_TO: Record<SubscriptionState, SubscriptionEvent[]> = {
  active: ['PAYMENT_SUCCEEDED'],
  past_due: ['TRIAL_ENDED', 'PAYMENT_FAILED'],
  cancelled: ['CANCELLED'],
  trialing: [],
};

/** The subscription event that moves `from` to the reported status, or null when none does. */
export function eventFor(from: SubscriptionState, reported: SubscriptionState): SubscriptionEvent | null {
  return EVENTS_TO[reported].find((e) => canTransition(subscriptionMachine, from, e)) ?? null;
}

export function createBilling(options: BillingOptions): Billing {
  const { db, messaging, provider } = options;
  const plan = options.plan ?? DEFAULT_PLAN;

  async function approverPhone(businessId: string): Promise<string> {
    const [row] = await db.withBusiness('billing', businessId, (tx) =>
      tx.select({ phone: schema.business.approverPhone }).from(schema.business).where(eq(schema.business.id, businessId)),
    );
    if (!row) throw new Error(`Unknown business: ${businessId}`);
    return row.phone;
  }

  async function notify(businessId: string, text: string): Promise<boolean> {
    try {
      await messaging.sendText(businessId, { to: await approverPhone(businessId), text });
      return true;
    } catch (error) {
      // A callback can arrive days after the owner last wrote; the status still applies.
      if (error instanceof WindowClosedError) return false;
      throw error;
    }
  }

  /**
   * The callback is only a trigger (contracts.md, PaymentProvider): the status comes from the provider
   * now, read while the subscription row is locked, so a stale, replayed or parallel callback applies
   * at most the current status once.
   */
  function apply(event: PaymentEvent): Promise<WebhookOutcome> {
    return db.withBusiness('billing', event.businessId, async (tx): Promise<WebhookOutcome> => {
      const [row] = await tx
        .select()
        .from(schema.subscription)
        .where(eq(schema.subscription.businessId, event.businessId))
        .for('update');
      if (!row || row.providerCustomerId !== event.providerCustomerId) return { kind: 'unknown_subscription' };
      if (row.providerSubscriptionId !== null && row.providerSubscriptionId !== event.providerSubscriptionId) {
        return { kind: 'unknown_subscription' };
      }
      const current = await provider.getSubscriptionStatus(event.providerSubscriptionId);
      if (row.status === current.status) return { kind: 'unchanged', status: row.status };
      const name = eventFor(row.status, current.status);
      if (!name) return { kind: 'rejected', from: row.status, reported: current.status };
      const to = transition(subscriptionMachine, row.status, name);
      await tx
        .update(schema.subscription)
        .set({
          status: to,
          providerSubscriptionId: event.providerSubscriptionId,
          ...(current.currentPeriodEnd === undefined ? {} : { currentPeriodEnd: new Date(current.currentPeriodEnd) }),
          updatedAt: new Date(),
        })
        .where(eq(schema.subscription.id, row.id));
      return { kind: 'applied', from: row.status, to, notified: false };
    });
  }

  return {
    async sendPaymentLink(businessId) {
      const link = await provider.createPaymentLink({ businessId, plan });
      await db.withBusiness('billing', businessId, async (tx) => {
        const [existing] = await tx.select().from(schema.subscription).where(eq(schema.subscription.businessId, businessId));
        if (existing) {
          await tx
            .update(schema.subscription)
            .set({ plan, provider: provider.name, providerCustomerId: link.providerCustomerId, updatedAt: new Date() })
            .where(eq(schema.subscription.id, existing.id));
        } else {
          await tx
            .insert(schema.subscription)
            .values({ businessId, plan, provider: provider.name, providerCustomerId: link.providerCustomerId });
        }
      });
      await messaging.sendText(businessId, { to: await approverPhone(businessId), text: BILLING_COPY.paymentLink(link.url) });
      return { url: link.url };
    },

    async handleWebhook(request) {
      const event = await provider.verifyWebhook(request);
      const outcome = await apply(event);
      if (outcome.kind !== 'applied' || outcome.to === 'trialing') return outcome;
      return { ...outcome, notified: await notify(event.businessId, BILLING_COPY[outcome.to]) };
    },
  };
}
