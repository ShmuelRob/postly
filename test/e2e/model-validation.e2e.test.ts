/**
 * Failed model validation (technical-design.md, Failure handling): the model simulator returns
 * output that breaks the task schema, the model layer retries within model_task_config.max_retries,
 * and the task lands in console_item for a person. The model layer, the seed rows, and the database
 * are real; the app around them is a stub in this file until the messaging and workflow modules
 * exist (WP-22, WP-23), and its owner-facing reply is placeholder copy.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, expect, inject } from 'vitest';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { createModelLayer, ModelTaskFailedError } from '../../src/modules/model-layer/index.js';
import { MessagingSimulator, ModelSimulator, PaymentSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { e2eTest, type AppFactory, type Providers } from './harness/index.js';

const OWNER = '+972501234567';
const BUSINESS_PHONE = '+972521111111';
const HOLDING_REPLY = 'קיבלתי, אני בודק ואחזור אליך בהקדם';

const db = createDatabase(inject('databaseUrls'), { max: 2 });
afterAll(() => db.close());

/** Stub app: classifies each owner text with the model layer; a failed task gets a holding reply. */
const appFor =
  (businessId: string): AppFactory =>
  ({ messaging, model }) => {
    const layer = createModelLayer({ db, providers: { google: model } });
    return {
      async deliverInbound(message) {
        if (message.content.kind !== 'text') return;
        try {
          await layer.run(businessId, 'intent_detection', { text: message.content.text, step: 'idle', draftsOpen: false });
        } catch (error) {
          if (!(error instanceof ModelTaskFailedError)) throw error;
          await messaging.sendText({ to: message.from, text: HOLDING_REPLY });
        }
      },
    };
  };

e2eTest('invalid model output is retried and then lands in the team console', async ({ e2e }) => {
  const businessId = randomUUID();
  await db.withSystem('console', (tx) =>
    tx.insert(schema.business).values({ id: businessId, name: 'מאפיית השכונה', approverPhone: OWNER }),
  );
  const model = new ModelSimulator({ defaults: false });
  // Three answers, none valid: an approval intent (which does not exist) and two broken shapes.
  model.scriptInvalid('intent_detection', { intent: 'approve', confidence: 1 }, { intent: 'weekly_update' }, 'שבוע טוב!');
  const providers = {
    messaging: new MessagingSimulator(),
    publishing: new PublishingSimulator(),
    model,
    payment: new PaymentSimulator(),
    renderer: { render: async () => ({}) },
  } satisfies Providers;
  const run = await e2e.start({ providers, app: appFor(businessId), ownerPhone: OWNER, businessPhone: BUSINESS_PHONE });

  await run.owner.sendsText('השבוע יש מבצע על חלות, 2 ב-20 ש"ח');

  expect(run.modelCalls().map((c) => [c.task, c.valid])).toEqual([
    ['intent_detection', false],
    ['intent_detection', false],
    ['intent_detection', false],
  ]);
  const { runs, items } = await db.withBusiness(businessId, async (tx) => ({
    runs: await tx.select().from(schema.modelRun).orderBy(schema.modelRun.attempt),
    items: await tx.select().from(schema.consoleItem),
  }));
  run.recordConsoleItems(items.map((i) => ({ kind: i.kind, details: i.details })));

  expect(runs.map((r) => [r.attempt, r.valid, r.promptVersion])).toEqual([
    [1, false, 1],
    [2, false, 1],
    [3, false, 1],
  ]);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: 'model_validation_failed', status: 'open', businessId });
  expect(items[0]?.details).toMatchObject({ task: 'intent_detection', attempts: 3, modelRunIds: runs.map((r) => r.id) });
  expect(run.owner.received().map((m) => m.text)).toEqual([HOLDING_REPLY]);
});
