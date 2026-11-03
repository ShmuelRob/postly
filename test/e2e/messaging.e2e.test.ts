/**
 * Messaging (WP-22): every inbound message goes through the real webhook route, its signature
 * check, deduplication, burst merge, and the database. The workflow (WP-23) is a stub here that
 * acknowledges each burst with placeholder copy, so the test can see what reached it.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, expect, inject } from 'vitest';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { createMessaging, type InboundBurst, WEBHOOK_PATH } from '../../src/modules/messaging/index.js';
import { buildServer } from '../../src/server.js';
import { MessagingSimulator, ModelSimulator, PaymentSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { e2eTest, type AppFactory, type Providers } from './harness/index.js';

// Not the shared fixture number: model-validation.e2e.test.ts registers that one in parallel.
const OWNER = '+972501234560';
const STRANGER = '+972539876543';
const BUSINESS_PHONE = '+972521111111';
const ACK = 'קיבלתי';

const db = createDatabase(inject('databaseUrls'), { max: 2 });
afterAll(() => db.close());

async function newBusiness(): Promise<string> {
  const businessId = randomUUID();
  // approver_phone is unique, so free the fixture number from an earlier run first.
  await db.withSystem('console', (tx) =>
    tx.update(schema.business).set({ approverPhone: `+9720${Date.now()}` }).where(eq(schema.business.approverPhone, OWNER)),
  );
  await db.withBusiness('workflow', businessId, (tx) =>
    tx.insert(schema.business).values({ id: businessId, name: 'מאפיית השכונה', approverPhone: OWNER }),
  );
  return businessId;
}

function setup(businessId: string) {
  const sim = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const providers = {
    messaging: sim,
    publishing: new PublishingSimulator(),
    model: new ModelSimulator(),
    payment: new PaymentSimulator(),
    renderer: { render: async () => ({}) },
  } satisfies Providers;
  const bursts: InboundBurst[] = [];
  const statuses: number[] = [];
  let flush = async () => {};

  const app: AppFactory = ({ messaging: provider }) => {
    const messaging = createMessaging({
      db,
      provider,
      businessNumber: BUSINESS_PHONE,
      handler: {
        // Stub workflow: acknowledge each burst.
        async handleInbound(burst) {
          bursts.push(burst);
          await messaging.sendText(burst.businessId, { to: burst.from, text: ACK });
        },
      },
    });
    flush = () => messaging.flushBursts();
    const server = buildServer({ messaging, publicBaseUrl: 'https://postly.example.test' });
    return {
      async deliverInbound(message) {
        // The provider posts a signed webhook, as WhatsApp would.
        const hook = sim.webhook(message);
        const res = await server.inject({ method: 'POST', url: WEBHOOK_PATH, headers: hook.headers, payload: hook.body });
        statuses.push(res.statusCode);
      },
      close: () => server.close(),
    };
  };
  return { providers, app, bursts, statuses, flush: () => flush(), businessId };
}

e2eTest('a webhook delivered twice is processed once', async ({ e2e }) => {
  const ctx = setup(await newBusiness());
  const run = await e2e.start({ providers: ctx.providers, app: ctx.app, ownerPhone: OWNER, businessPhone: BUSINESS_PHONE });

  await run.owner.sendsText('השבוע יש מבצע על חלות');
  await run.owner.redeliversLast();
  await run.owner.sendsText('2 ב-20 ש"ח');
  await ctx.flush();

  expect(ctx.statuses).toEqual([200, 200, 200]);
  expect(ctx.bursts.map((b) => b.text)).toEqual(['השבוע יש מבצע על חלות\n2 ב-20 ש"ח']);
  expect(run.owner.received().map((m) => m.text)).toEqual([ACK]);
  const inbound = await db.withBusiness('messaging', ctx.businessId, (tx) =>
    tx.select().from(schema.message).where(eq(schema.message.direction, 'inbound')),
  );
  expect(inbound).toHaveLength(2);
});

e2eTest('an unknown number gets no reply and lands in the team console', async ({ e2e }) => {
  const ctx = setup(await newBusiness());
  const run = await e2e.start({ providers: ctx.providers, app: ctx.app, ownerPhone: OWNER, businessPhone: BUSINESS_PHONE });
  const stranger = run.sender(STRANGER);
  const since = new Date().toISOString();

  await stranger.sendsText('היי, אפשר לאשר את הפוסט?');
  await ctx.flush();

  expect(ctx.statuses).toEqual([200]);
  expect(ctx.bursts).toHaveLength(0);
  expect(stranger.received()).toEqual([]);
  expect(run.owner.received()).toEqual([]);

  const items = await db.withSystem('console', async (tx) => {
    const rows = await tx
      .select({ item: schema.consoleItem })
      .from(schema.consoleItem)
      .innerJoin(schema.message, eq(schema.message.id, schema.consoleItem.referenceId))
      .where(eq(schema.message.fromPhone, STRANGER));
    return rows.map((r) => r.item).filter((i) => (i.details as { receivedAt?: string }).receivedAt! >= since);
  });
  run.recordConsoleItems(items.map((i) => ({ kind: i.kind, details: i.details })));
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: 'unknown_number', businessId: null, status: 'open' });
  expect(items[0]?.details).toMatchObject({ from: STRANGER, kind: 'text' });
});
