/**
 * Billing (WP-42): the payment link goes to the owner in WhatsApp through the real messaging
 * module, the owner pays on the simulated provider's page, and the provider's signed callbacks
 * reach the real payment webhook route, which applies the subscription machine
 * (state-machines.md, Subscription). The Hebrew copy is provisional.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, expect, inject } from 'vitest';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { BILLING_COPY, createBilling, PAYMENT_WEBHOOK_PATH } from '../../src/modules/billing/index.js';
import { createMessaging, WEBHOOK_PATH } from '../../src/modules/messaging/index.js';
import { buildServer } from '../../src/server.js';
import { MessagingSimulator, ModelSimulator, PaymentSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { e2eTest, type AppFactory, type Providers } from './harness/index.js';

const OWNER = '+972501234570';
const BUSINESS_PHONE = '+972521111113';

const db = createDatabase(inject('databaseUrls'), { max: 2 });
afterAll(() => db.close());

async function newBusiness(): Promise<string> {
  const businessId = randomUUID();
  await db.withSystem('console', (tx) =>
    tx.update(schema.business).set({ approverPhone: `+9720${Date.now()}` }).where(eq(schema.business.approverPhone, OWNER)),
  );
  await db.withBusiness('workflow', businessId, (tx) =>
    tx.insert(schema.business).values({ id: businessId, name: 'מספרת רותי', approverPhone: OWNER }),
  );
  return businessId;
}

// One simulator for the file: its outbound message ids are unique only within one instance.
const sim = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });

function setup(businessId: string) {
  const payment = new PaymentSimulator();
  const providers = {
    messaging: sim,
    publishing: new PublishingSimulator(),
    model: new ModelSimulator(),
    payment,
    renderer: { render: async () => ({}) },
  } satisfies Providers;
  const statuses: number[] = [];
  let sendLink = async () => {};
  let deliverPaymentWebhook = async (_id: string, _tamper?: boolean) => {};

  const app: AppFactory = ({ messaging: provider }) => {
    // The workflow is not part of this flow: the owner's messages only open the 24-hour window.
    const messaging = createMessaging({ db, provider, businessNumber: BUSINESS_PHONE, handler: { async handleInbound() {} } });
    const billing = createBilling({ db, messaging, provider: payment });
    const server = buildServer({ messaging, billing, publicBaseUrl: 'https://postly.example.test' });
    sendLink = async () => {
      await billing.sendPaymentLink(businessId);
    };
    deliverPaymentWebhook = async (subscriptionId, tamper = false) => {
      const hook = payment.webhook(subscriptionId);
      const body = tamper ? hook.body.replace('"past_due"', '"active"') : hook.body;
      const res = await server.inject({ method: 'POST', url: PAYMENT_WEBHOOK_PATH, headers: hook.headers, payload: body });
      statuses.push(res.statusCode);
    };
    return {
      async deliverInbound(message) {
        const hook = sim.webhook(message);
        await server.inject({ method: 'POST', url: WEBHOOK_PATH, headers: hook.headers, payload: hook.body });
        await messaging.flushBursts();
      },
      close: () => server.close(),
    };
  };
  return {
    providers,
    app,
    payment,
    statuses,
    sendLink: () => sendLink(),
    deliverPaymentWebhook: (id: string, tamper?: boolean) => deliverPaymentWebhook(id, tamper),
  };
}

async function stored(businessId: string) {
  const [row] = await db.withSystem('console', (tx) =>
    tx.select().from(schema.subscription).where(eq(schema.subscription.businessId, businessId)),
  );
  return row;
}

e2eTest('the owner gets a payment link, pays, and the subscription moves through its states', async ({ e2e }) => {
  const businessId = await newBusiness();
  const ctx = setup(businessId);
  const run = await e2e.start({ providers: ctx.providers, app: ctx.app, ownerPhone: OWNER, businessPhone: BUSINESS_PHONE });

  await run.owner.sendsText('איך משלמים על המנוי?');
  await ctx.sendLink();

  const [link] = ctx.payment.links;
  expect(link?.request).toEqual({ businessId, plan: 'basic' });
  expect(run.owner.received().map((m) => m.text)).toEqual([BILLING_COPY.paymentLink(link!.link.url)]);
  expect(await stored(businessId)).toMatchObject({
    status: 'trialing',
    provider: 'simulator',
    providerCustomerId: link!.link.providerCustomerId,
    providerSubscriptionId: null,
  });

  // The owner pays on the provider's page; the provider calls back.
  const subscriptionId = ctx.payment.completePayment(link!.link.providerCustomerId, {
    currentPeriodEnd: '2026-12-03T10:00:00.000Z',
  });
  await ctx.deliverPaymentWebhook(subscriptionId);
  await ctx.deliverPaymentWebhook(subscriptionId); // the provider retries: nothing changes, nothing is sent
  expect(await stored(businessId)).toMatchObject({ status: 'active', providerSubscriptionId: subscriptionId });

  // A renewal fails, then a forged "recovered" callback is refused, then the real recovery arrives.
  ctx.payment.setStatus(subscriptionId, 'past_due');
  await ctx.deliverPaymentWebhook(subscriptionId);
  await ctx.deliverPaymentWebhook(subscriptionId, true);
  expect((await stored(businessId))?.status).toBe('past_due');
  ctx.payment.setStatus(subscriptionId, 'active');
  await ctx.deliverPaymentWebhook(subscriptionId);

  expect(ctx.statuses).toEqual([200, 200, 200, 401, 200]);
  expect(await stored(businessId)).toMatchObject({ status: 'active', currentPeriodEnd: new Date('2026-12-03T10:00:00.000Z') });
  expect(run.owner.received().map((m) => m.text)).toEqual([
    BILLING_COPY.paymentLink(link!.link.url),
    BILLING_COPY.active,
    BILLING_COPY.past_due,
    BILLING_COPY.active,
  ]);
}, 30_000);

e2eTest('a cancelled subscription stays cancelled', async ({ e2e }) => {
  const businessId = await newBusiness();
  const ctx = setup(businessId);
  const run = await e2e.start({ providers: ctx.providers, app: ctx.app, ownerPhone: OWNER, businessPhone: BUSINESS_PHONE });

  await run.owner.sendsText('אני רוצה לשלם');
  await ctx.sendLink();
  const subscriptionId = ctx.payment.completePayment(ctx.payment.links[0]!.link.providerCustomerId);
  await ctx.deliverPaymentWebhook(subscriptionId);
  await ctx.payment.cancelSubscription(subscriptionId);
  await ctx.deliverPaymentWebhook(subscriptionId);
  // cancelled is terminal: a later "active" callback is rejected.
  ctx.payment.setStatus(subscriptionId, 'active');
  await ctx.deliverPaymentWebhook(subscriptionId);

  expect((await stored(businessId))?.status).toBe('cancelled');
  expect(run.owner.received().map((m) => m.text).slice(1)).toEqual([BILLING_COPY.active, BILLING_COPY.cancelled]);
}, 30_000);
