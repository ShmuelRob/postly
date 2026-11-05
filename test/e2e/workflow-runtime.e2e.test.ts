/**
 * Workflow runtime (WP-23, state-machines.md): an event with no transition from the current state
 * is rejected and logged without changing state, and while a person handles the conversation
 * (handoff) the agent sends no automatic replies and applies no inbound events. The workflow
 * runtime and the database are real; the app around it is a stub in this file until the
 * messaging module and the product flows exist (WP-22, WP-30+), so its intent mapping is keyword
 * based and its owner-facing replies are placeholder copy. Every applied and rejected event also
 * leaves one `workflow_event` audit row (WP-46), read here through the console.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, expect, inject } from 'vitest';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { createWorkflow, type RejectionLog } from '../../src/modules/workflow/index.js';
import { MessagingSimulator, ModelSimulator, PaymentSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { e2eTest, type AppFactory, type Providers } from './harness/index.js';

const OWNER = '+972501234568';
const BUSINESS_PHONE = '+972521111112';
const NOT_NOW = 'עוד אין טיוטות לתזמן. שלחו לי את העדכון השבועי ואכין טיוטות';
const HANDING_OFF = 'מעביר אותך לנציג, נחזור אליך בהקדם';
const GOT_UPDATE = 'תודה! מכין טיוטות לשבוע';

const db = createDatabase(inject('databaseUrls'), { max: 2 });
afterAll(() => db.close());

const rejections: RejectionLog[] = [];
const workflow = createWorkflow(db, { rejected: (entry) => rejections.push(entry) });

/** Stub app: keyword intents mapped to conversation events through the real workflow runtime. */
const appFor =
  (businessId: string): AppFactory =>
  ({ messaging }) => ({
    async deliverInbound(message) {
      if (message.content.kind !== 'text') return;
      if (!(await workflow.mayAutoReply(businessId))) return;
      const text = message.content.text;
      const reply = (body: string) => messaging.sendText({ to: message.from, text: body });
      if (text.includes('נציג')) {
        await workflow.startHandoff(businessId, { reason: 'owner asked for a person' });
        return void (await reply(HANDING_OFF));
      }
      const event = text.includes('תזמון') ? 'SCHEDULE_CONFIRMED' : 'UPDATE_RECEIVED';
      const result = await workflow.apply(businessId, { machine: 'conversation', id: businessId, event, source: 'inbound', correlationId: message.providerMessageId });
      await reply(result.ok ? GOT_UPDATE : NOT_NOW);
    },
  });

const stepOf = (businessId: string) =>
  db.withBusiness('workflow', businessId, async (tx) => {
    const [row] = await tx.select().from(schema.conversationState).where(eq(schema.conversationState.businessId, businessId));
    return row?.step;
  });

e2eTest('an invalid transition is rejected and logged, handoff stops automatic replies, and both events are audited', async ({ e2e }) => {
  const businessId = randomUUID();
  await db.withBusiness('workflow', businessId, async (tx) => {
    await tx.insert(schema.business).values({ id: businessId, name: 'מספרת רחוב הרצל', status: 'active', approverPhone: OWNER });
    await tx.insert(schema.conversationState).values({ businessId, step: 'idle' });
  });
  const providers = {
    messaging: new MessagingSimulator(),
    publishing: new PublishingSimulator(),
    model: new ModelSimulator(),
    payment: new PaymentSimulator(),
    renderer: { render: async () => ({}) },
  } satisfies Providers;
  const run = await e2e.start({ providers, app: appFor(businessId), ownerPhone: OWNER, businessPhone: BUSINESS_PHONE });

  // 1. Confirming a schedule while idle has no transition: rejected, logged, state unchanged.
  await run.owner.sendsText('מאשר את התזמון');
  expect(await stepOf(businessId)).toBe('idle');
  expect(rejections).toEqual([
    { businessId, machine: 'conversation', id: businessId, event: 'SCHEDULE_CONFIRMED', source: 'inbound', reason: 'invalid_transition', from: 'idle' },
  ]);

  // 2. The owner asks for a person: handoff starts and a console item opens.
  await run.owner.sendsText('אפשר לדבר עם נציג?');
  // 3. While handed off, the update gets no automatic reply and does not move the conversation.
  await run.owner.sendsText('השבוע מבצע: תספורת ב-60 ש"ח');
  expect(await stepOf(businessId)).toBe('idle');
  expect(run.owner.received().map((m) => m.text)).toEqual([NOT_NOW, HANDING_OFF]);

  const items = await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.consoleItem));
  expect(items).toMatchObject([{ kind: 'handoff', status: 'open' }]);
  run.recordConsoleItems([
    ...rejections.map((r) => ({ kind: `log: ${r.reason}`, details: { machine: r.machine, event: r.event, from: r.from } })),
    ...items.map((i) => ({ kind: i.kind, details: i.details })),
  ]);

  // 4. The team clears the handoff from the console; the same step resumes and replies return.
  await workflow.clearHandoff(businessId);
  await run.owner.sendsText('השבוע מבצע: תספורת ב-60 ש"ח');
  expect(await stepOf(businessId)).toBe('processing_update');
  expect(run.owner.received().map((m) => m.text)).toEqual([NOT_NOW, HANDING_OFF, GOT_UPDATE]);

  // 5. The audit trail (WP-46): the rejected and the applied event each left one row, tied to the
  // inbound message that raised it. The handed-off message raised no event, so it left none.
  const audit = await db.withSystem('console', (tx) =>
    tx.select().from(schema.workflowEvent).where(eq(schema.workflowEvent.businessId, businessId)).orderBy(schema.workflowEvent.createdAt),
  );
  expect(audit.map(({ machine, event, outcome, fromState, toState, reason, actor, source }) => ({ machine, event, outcome, fromState, toState, reason, actor, source }))).toEqual([
    { machine: 'conversation', event: 'SCHEDULE_CONFIRMED', outcome: 'rejected', fromState: 'idle', toState: null, reason: 'invalid_transition', actor: 'owner', source: 'inbound' },
    { machine: 'conversation', event: 'UPDATE_RECEIVED', outcome: 'applied', fromState: 'idle', toState: 'processing_update', reason: null, actor: 'owner', source: 'inbound' },
  ]);
  // Each row carries its own inbound message's provider id.
  expect(new Set(audit.map((r) => r.correlationId).filter(Boolean)).size).toBe(2);
  run.recordConsoleItems(
    audit.map((r) => ({
      kind: `audit: ${r.outcome}`,
      details: { machine: r.machine, event: r.event, from: r.fromState, to: r.toState, reason: r.reason, actor: r.actor, correlationId: r.correlationId },
    })),
  );
});
