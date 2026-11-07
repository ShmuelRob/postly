/**
 * The owner is never left without a reply (agent.md, Runtime: "No silent turn"; review queue item 73).
 * On dev on 2026-11-06 an onboarding turn ended with end_turn, sent nothing and was not done, and the
 * owner's last message got no answer at all. Here the real onboarding flow runs on the scripted agent
 * (no real model): a turn that says nothing hands off, and so does a turn whose model call fails every
 * attempt. In both the owner reads the fixed hand-off line, and the team gets a console item.
 */
import { eq } from 'drizzle-orm';
import { afterAll, expect, inject } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { handOffLine, onboardingBatches } from '../../src/modules/agent/index.js';
import { WEBHOOK_PATH } from '../../src/modules/messaging/index.js';
import { onboardingCopy as copy } from '../../src/modules/workflow/index.js';
import { buildServer } from '../../src/server.js';
import { MessagingSimulator, ModelSimulator, PaymentSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import type { AgentTurnReport } from '../../src/simulators/scripted-agent.js';
import { call, providerFailure, step } from '../../src/simulators/scripted-agent.js';
import { e2eTest, type AppFactory, type E2eHarness, type Providers } from './harness/index.js';

const BUSINESS_PHONE = '+972521111193';

const db = createDatabase(inject('databaseUrls'), { max: 3 });
afterAll(() => db.close());

/** Nothing in these tests reaches a render or a stored file; both refuse if something does. */
const noDesign = { forBusiness: () => ({ render: async () => Promise.reject(new Error('no rendering in this test')) }) } as unknown as Parameters<typeof createApp>[0]['design'];
const noMedia = {
  put: async () => Promise.reject(new Error('no media in this test')),
  urlFor: (path: string) => `https://media.postly.test/${path}`,
  read: async () => undefined,
};

async function start(e2e: E2eHarness, owner: string, script: (model: ModelSimulator) => void) {
  const messagingSim = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const modelSim = new ModelSimulator({ strictAgents: true });
  script(modelSim);
  const providers = {
    messaging: messagingSim,
    publishing: new PublishingSimulator(),
    model: modelSim,
    payment: new PaymentSimulator(),
    renderer: { render: async () => ({}) },
  } satisfies Providers;
  await db.withSystem('console', (tx) => tx.update(schema.business).set({ approverPhone: `+9720${Date.now()}` }).where(eq(schema.business.approverPhone, owner)));

  let onboarding: ReturnType<typeof createApp>['onboarding'] | undefined;
  let record: (turn: AgentTurnReport) => void = () => {};
  const app: AppFactory = ({ messaging: messagingProvider, publishing, model }) => {
    const postly = createApp({
      db,
      oneShotFlows: false,
      providers: { messaging: messagingProvider, publishing, models: { google: model }, payment: providers.payment },
      businessNumber: BUSINESS_PHONE,
      design: noDesign,
      media: noMedia,
      samplePhotoUrl: 'https://media.postly.test/bundled/sample.jpg',
      onAgentTurnEnd: (turn) => record(turn as AgentTurnReport),
    });
    onboarding = postly.onboarding;
    const server = buildServer({ messaging: postly.messaging, billing: postly.billing!, publicBaseUrl: 'https://postly.example.test' });
    return {
      async deliverInbound(message) {
        const hook = messagingSim.webhook(message);
        const res = await server.inject({ method: 'POST', url: WEBHOOK_PATH, headers: hook.headers, payload: hook.body });
        expect(res.statusCode).toBe(200);
        await postly.messaging.flushBursts();
      },
      close: () => server.close(),
    };
  };
  const run = await e2e.start({ providers, app, ownerPhone: owner, businessPhone: BUSINESS_PHONE });
  record = (turn) => run.recordAgentTurn(turn);
  const businessId = await onboarding!.createBusiness({ approverPhone: owner });
  const items = () => db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.consoleItem));
  const handoffAt = async () => (await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.conversationState)))[0]!.handoffAt;
  return { run, modelSim, items, handoffAt, said: () => run.owner.received().map((m) => m.text) };
}

e2eTest('a turn that ends without a word hands off: the owner reads the hand-off line, the team gets the turn', { timeout: 90_000 }, async ({ e2e }) => {
  const { run, modelSim, items, handoffAt, said } = await start(e2e, '+972501230095', (model) =>
    model.scriptAgent(
      'onboarding',
      // Batch A went out by code after the intro (A11). The owner answers; the agent only ends its
      // turn, as on dev on 2026-11-06: nothing saved, nothing asked.
      [step(call.endTurn())],
    ),
  );

  await run.owner.sendsText('היי, נרשמתי לפוסטלי');
  expect(said()).toEqual([copy.intro('פוסטלי'), onboardingBatches.a]);

  await run.owner.sendsText('קוראים לנו פרחי דנה');
  expect(said()).toEqual([copy.intro('פוסטלי'), onboardingBatches.a, handOffLine('פוסטלי', 'he')]);
  expect(await handoffAt()).not.toBeNull();
  expect((await items()).map((i) => [i.kind, (i.details as { reason?: string }).reason])).toEqual([['agent_limit', 'silent_turn']]);
  expect(modelSim.agentScriptProblems()).toEqual([]);
});

e2eTest('a turn whose model call fails every attempt hands off with the line too', { timeout: 90_000 }, async ({ e2e }) => {
  const { run, items, handoffAt, said } = await start(e2e, '+972501230096', (model) =>
    model.scriptAgent(
      'onboarding',
      // Vertex down: three attempts (max_retries 2) all fail.
      [providerFailure('Vertex AI 503'), providerFailure('Vertex AI 503'), providerFailure('Vertex AI 503')],
    ),
  );

  await run.owner.sendsText('היי, נרשמתי לפוסטלי');
  await run.owner.sendsText('קוראים לנו פרחי דנה');
  expect(said().at(-1)).toBe(handOffLine('פוסטלי', 'he'));
  expect(await handoffAt()).not.toBeNull();
  const kinds = (await items()).map((i) => [i.kind, (i.details as { reason?: string }).reason]);
  expect(kinds).toContainEqual(['agent_limit', 'invalid_output']);
  expect(kinds).toContainEqual(['model_validation_failed', undefined]);
});
