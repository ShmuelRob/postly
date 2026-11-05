import { and, desc, eq, isNull } from 'drizzle-orm';
import { BusinessProfile } from '../../contracts/business-profile.js';
import { WindowClosedError, type WebhookRequest } from '../../contracts/providers/messaging.js';
import type { PaymentEvent, PaymentProvider, PaymentWebhooks, PlanPrice } from '../../contracts/providers/payment.js';
import { subscriptionMachine, type SubscriptionState } from '../../contracts/state-machines/index.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { canTransition, transition } from '../../shared/state-machine.js';
import type { Messaging } from '../messaging/index.js';
import { log } from '../../shared/logger.js';
import { holdCopy, holdOn, holdStep } from './hold.js';

type SubscriptionEvent = (typeof subscriptionMachine.events)[number];

/** PRD, Payment: a single plan for now. */
export const DEFAULT_PLAN = 'basic';

/** Owner-facing copy. Provisional (H6): drafted from the PRD and queued for the human. */
/** Agorot as shekels for the owner: 30000 is "300", 29950 is "299.50". */
export const shekels = (amountAgorot: number) =>
  amountAgorot % 100 === 0 ? String(amountAgorot / 100) : (amountAgorot / 100).toFixed(2);

export const BILLING_COPY = {
  paymentLink: (url: string, amountAgorot: number) =>
    `המנוי ל-Postly עולה ${shekels(amountAgorot)} ₪ לחודש. כדי להפעיל אותו, אפשר לשלם בקישור המאובטח:\n${url}\nהתשלום מתבצע באתר של ספק התשלום, ואנחנו לא שומרים את פרטי הכרטיס.`,
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
  /**
   * The provider reported the subscription `cancelled`: the business is cancelled (WP-43). The owner
   * then gets the cancellation template from it, not billing's text.
   */
  onCancelled?(businessId: string): Promise<void>;
  /**
   * The billing hold (T16): pauses or resumes the business through the existing business pause
   * (`PAUSE` / `RESUME`, source `system`). Resolves false when the machine refused.
   */
  pauseBusiness?(businessId: string): Promise<boolean>;
  resumeBusiness?(businessId: string): Promise<boolean>;
  now?: () => Date;
}

export type HoldAction = { businessId: string; action: 'reminded' | 'held' };

export interface Billing {
  /** Creates the payment link, stores the subscription row, and sends the link to the approver in WhatsApp. */
  sendPaymentLink(businessId: string): Promise<{ url: string }>;
  /** Verifies the provider's callback, then applies the provider's current status; throws InvalidWebhookSignatureError when it does not verify. */
  handleWebhook(request: WebhookRequest): Promise<WebhookOutcome>;
  /**
   * Cancellation (WP-43): a subscription with a provider id that is not `cancelled` is cancelled at the
   * payment provider, then stored `cancelled`. Idempotent; no subscription row is a no-op.
   */
  cancel(businessId: string): Promise<void>;
  /**
   * The daily billing-hold tick (technical-design.md, Billing): reminders on days 1, 3 and 6 of the
   * grace period, then the business pause on day 7. Only `active` businesses; `businessId` limits it to one.
   */
  holdTick(now: Date, options?: { businessId?: string }): Promise<HoldAction[]>;
}

const EVENTS_TO: Record<SubscriptionState, SubscriptionEvent[]> = {
  active: ['PAYMENT_SUCCEEDED'],
  past_due: ['PAYMENT_FAILED'],
  cancelled: ['CANCELLED'],
  pending: [],
};

/** The subscription event that moves `from` to the reported status, or null when none does. */
export function eventFor(from: SubscriptionState, reported: SubscriptionState): SubscriptionEvent | null {
  return EVENTS_TO[reported].find((e) => canTransition(subscriptionMachine, from, e)) ?? null;
}

export function createBilling(options: BillingOptions): Billing {
  const { db, messaging, provider } = options;
  const plan = options.plan ?? DEFAULT_PLAN;
  const now = options.now ?? (() => new Date());

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
  function apply(event: PaymentEvent): Promise<WebhookOutcome & { wasHeld?: boolean }> {
    return db.withBusiness('billing', event.businessId, async (tx): Promise<WebhookOutcome & { wasHeld?: boolean }> => {
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
          // The billing hold (T16): a failure starts a grace period, a payment ends it.
          ...(to === 'past_due' ? { graceStartedAt: now(), remindersSent: 0, heldAt: null } : {}),
          ...(to === 'active' ? { graceStartedAt: null, remindersSent: 0, heldAt: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.subscription.id, row.id));
      return { kind: 'applied', from: row.status, to, notified: false, wasHeld: to === 'active' && row.heldAt !== null };
    });
  }

  /** The plan's current price: its newest `plan_price` row (database-schema.md). */
  async function currentPrice(businessId: string): Promise<PlanPrice> {
    const [row] = await db.withBusiness('billing', businessId, (tx) =>
      tx.select().from(schema.planPrice).where(eq(schema.planPrice.plan, plan)).orderBy(desc(schema.planPrice.id)).limit(1),
    );
    if (!row) throw new Error(`Plan ${plan} has no price`);
    return { amountAgorot: row.amountAgorot, currency: 'ILS' };
  }

  async function owner(businessId: string) {
    const [row] = await db.withBusiness('billing', businessId, (tx) => tx.select().from(schema.business).where(eq(schema.business.id, businessId)));
    if (!row) throw new Error(`Unknown business: ${businessId}`);
    const profile = BusinessProfile.safeParse(row.profile);
    return { phone: row.approverPhone, name: row.name, timezone: row.timezone, language: profile.success ? profile.data.languages[0]! : 'he' };
  }

  /** One business's step of the hold tick; the row's counters make a repeated or parallel tick a no-op. */
  async function holdOne(businessId: string, at: Date): Promise<HoldAction['action'] | null> {
    const [row] = await db.withBusiness('billing', businessId, (tx) => tx.select().from(schema.subscription).where(eq(schema.subscription.businessId, businessId)));
    if (!row || (row.status !== 'pending' && row.status !== 'past_due') || !row.graceStartedAt) return null;
    const step = holdStep(row, at);
    if (step.kind === 'none') return null;
    const to = await owner(businessId);
    const sameRow = and(
      eq(schema.subscription.id, row.id),
      eq(schema.subscription.status, row.status),
      eq(schema.subscription.remindersSent, row.remindersSent),
      isNull(schema.subscription.heldAt),
    );
    if (step.kind === 'remind') {
      const variables: Record<string, string> = { businessName: to.name, holdOn: holdOn(row.graceStartedAt, to.timezone) };
      let customerId = row.providerCustomerId;
      // A fresh link only while nothing was paid: for `past_due` it would detach the provider's subscription.
      if (row.status === 'pending') {
        const link = await provider.createPaymentLink({ businessId, plan: row.plan, price: await currentPrice(businessId) });
        variables.link = link.url;
        customerId = link.providerCustomerId;
      }
      const claimed = await db.withBusiness('billing', businessId, (tx) =>
        tx
          .update(schema.subscription)
          .set({ remindersSent: step.remindersSent, providerCustomerId: customerId, updatedAt: new Date() })
          .where(sameRow)
          .returning({ id: schema.subscription.id }),
      );
      if (claimed.length === 0) return null;
      await messaging.sendTemplate(businessId, {
        to: to.phone,
        language: to.language,
        templateName: row.status === 'pending' ? holdCopy.REMINDER_TEMPLATE : holdCopy.FAILED_TEMPLATE,
        variables,
      });
      return 'reminded';
    }
    const claimed = await db.withBusiness('billing', businessId, (tx) =>
      tx.update(schema.subscription).set({ heldAt: at, updatedAt: new Date() }).where(sameRow).returning({ id: schema.subscription.id }),
    );
    if (claimed.length === 0) return null;
    if (!options.pauseBusiness || !(await options.pauseBusiness(businessId))) {
      // The business left `active` meanwhile (a team pause, a cancellation): billing holds nothing.
      await db.withBusiness('billing', businessId, (tx) => tx.update(schema.subscription).set({ heldAt: null }).where(eq(schema.subscription.id, row.id)));
      return null;
    }
    await messaging.sendTemplate(businessId, { to: to.phone, language: to.language, templateName: holdCopy.HOLD_TEMPLATE, variables: { businessName: to.name } });
    return 'held';
  }

  return {
    async holdTick(at, tickOptions = {}) {
      const active = await db.withSystem('scheduler', (tx) =>
        tx
          .select({ id: schema.business.id })
          .from(schema.business)
          .where(and(eq(schema.business.status, 'active'), tickOptions.businessId ? eq(schema.business.id, tickOptions.businessId) : undefined)),
      );
      const done: HoldAction[] = [];
      for (const { id } of active) {
        try {
          const action = await holdOne(id, at);
          if (action) done.push({ businessId: id, action });
        } catch (error) {
          log.error('billing hold failed', { businessId: id, error: error instanceof Error ? error : String(error) });
        }
      }
      return done;
    },

    async sendPaymentLink(businessId) {
      const price = await currentPrice(businessId);
      const link = await provider.createPaymentLink({ businessId, plan, price });
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
            .values({ businessId, plan, provider: provider.name, providerCustomerId: link.providerCustomerId, graceStartedAt: now() });
        }
      });
      await messaging.sendText(businessId, { to: await approverPhone(businessId), text: BILLING_COPY.paymentLink(link.url, price.amountAgorot) });
      return { url: link.url };
    },

    async cancel(businessId) {
      // The provider call holds no row lock (review of PR #54): cancelling at the provider is idempotent,
      // so a parallel callback or a second cancel can run meanwhile, and the stored status is set after it.
      const [row] = await db.withBusiness('billing', businessId, (tx) => tx.select().from(schema.subscription).where(eq(schema.subscription.businessId, businessId)));
      if (!row || row.status === 'cancelled') return;
      if (row.providerSubscriptionId) await provider.cancelSubscription(row.providerSubscriptionId);
      await db.withBusiness('billing', businessId, async (tx) => {
        const [locked] = await tx.select().from(schema.subscription).where(eq(schema.subscription.id, row.id)).for('update');
        if (!locked || locked.status === 'cancelled') return;
        await tx
          .update(schema.subscription)
          .set({ status: transition(subscriptionMachine, locked.status, 'CANCELLED'), updatedAt: new Date() })
          .where(eq(schema.subscription.id, row.id));
      });
    },

    async handleWebhook(request) {
      const event = await provider.verifyWebhook(request);
      const { wasHeld, ...outcome } = await apply(event);
      if (wasHeld && options.resumeBusiness && !(await options.resumeBusiness(event.businessId))) {
        log.error('billing hold: resume refused', { businessId: event.businessId });
      }
      if (outcome.kind !== 'applied' || outcome.to === 'pending') return outcome;
      if (outcome.to === 'cancelled' && options.onCancelled) {
        await options.onCancelled(event.businessId);
        return { ...outcome, notified: true };
      }
      return { ...outcome, notified: await notify(event.businessId, BILLING_COPY[outcome.to]) };
    },
  };
}
