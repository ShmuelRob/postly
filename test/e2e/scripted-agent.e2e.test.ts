/**
 * The scripted agent in an end-to-end run (WP-91; agent.md, Testing without paying for a model), on
 * the real agent runtime (WP-90), messaging module and database. The model simulator plays a script
 * in strict mode, so any agent call without a script fails the test; nothing here can reach a real
 * model. The runtime's onTurnEnd hook puts every turn, with its last step's results and its stop
 * reason, into the e2e report next to the scripted steps.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, expect, inject } from 'vitest';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { createAgent, type Agent } from '../../src/modules/agent/index.js';
import { createMessaging } from '../../src/modules/messaging/index.js';
import { createModelLayer } from '../../src/modules/model-layer/index.js';
import { MessagingSimulator, ModelSimulator, PaymentSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { call, step } from '../../src/simulators/scripted-agent.js';
import { e2eTest, type AppFactory, type E2eRun, type Providers } from './harness/index.js';

const OWNER = '+972501234591';
const BUSINESS_PHONE = '+972521111191';
const UPDATE = 'השבוע 20% הנחה על כל זרי הסתיו';
const ANSWER = 'עד יום חמישי';
const QUESTION = 'עד מתי בתוקף ה-20% הנחה?';

const db = createDatabase(inject('databaseUrls'), { max: 3 });
afterAll(() => db.close());

async function newBusiness(): Promise<string> {
  const businessId = randomUUID();
  await db.withSystem('console', (tx) => tx.update(schema.business).set({ approverPhone: `+9720${Date.now()}` }).where(eq(schema.business.approverPhone, OWNER)));
  await db.withBusiness('workflow', businessId, async (tx) => {
    await tx.insert(schema.business).values({ id: businessId, name: 'הפרחים של רינה', status: 'active', approverPhone: OWNER, profile: { name: 'הפרחים של רינה', approverPhone: OWNER } });
    await tx.insert(schema.conversationState).values({ businessId, step: 'processing_update' });
  });
  return businessId;
}

e2eTest('a scripted weekly agent has a number refused, asks one question, and acknowledges the answer', async ({ e2e }) => {
  await newBusiness();
  const model = new ModelSimulator({ defaults: false, strictAgents: true });
  model.scriptAgent(
    'weekly',
    // Turn 1, on the update: a question with a number the owner never wrote is refused (fact_mismatch),
    // and the refusal goes back to the agent, which asks with the owner's own number.
    [step(call.askOwner('ה-30% הנחה בתוקף עד מתי?', { topic: 'detail:date' })), step(call.askOwner(QUESTION, { topic: 'detail:date' }))],
    // Turn 2, on the answer: an acknowledgement, then the turn ends.
    [step(call.askOwner('תודה, רשמתי', { expects: 'none' }), call.endTurn())],
  );
  const providers = {
    messaging: new MessagingSimulator({ businessNumber: BUSINESS_PHONE }),
    publishing: new PublishingSimulator(),
    model,
    payment: new PaymentSimulator(),
    renderer: { render: async () => ({}) },
  } satisfies Providers;

  const questions: string[] = [];
  let agent!: Agent;
  let run!: E2eRun;
  let flush = async () => {};
  const app: AppFactory = ({ messaging: provider, model: recorded }) => {
    const messaging = createMessaging({
      db,
      provider,
      businessNumber: BUSINESS_PHONE,
      // The routing from the workflow to the agent is WP-93's; here every burst runs a weekly turn.
      handler: { handleInbound: async (burst) => void (await agent.runTurn(burst.businessId, 'weekly', { kind: 'burst', messageIds: burst.messages.map((m) => m.id) })) },
    });
    agent = createAgent({
      db,
      models: createModelLayer({ db, providers: { google: recorded } }),
      messaging,
      events: { questionAsked: async (_b, q) => void questions.push(q.key) },
      onTurnEnd: (turn) => run.recordAgentTurn(turn),
    });
    flush = () => messaging.flushBursts();
    return { deliverInbound: async (message) => void (await messaging.receive(message)) };
  };
  run = await e2e.start({ providers, app, ownerPhone: OWNER, businessPhone: BUSINESS_PHONE });

  await run.owner.sendsText(UPDATE);
  await flush();
  expect(run.owner.received().map((m) => m.text)).toEqual([QUESTION]);
  expect(questions).toEqual(['detail:date']);

  await run.owner.sendsText(ANSWER);
  await flush();
  expect(run.owner.received().map((m) => m.text)).toEqual([QUESTION, 'תודה, רשמתי']);

  // What the report shows: each scripted step, its calls, and what code answered.
  expect(model.agentSteps.map((s) => [s.turn, s.step, s.calls?.map((c) => c.tool), s.results.map((r) => r.result.status)])).toEqual([
    [1, 1, ['ask_owner'], ['refused']],
    [1, 2, ['ask_owner'], []],
    [2, 1, ['ask_owner', 'end_turn'], []],
  ]);
  expect(model.agentSteps[0]!.results[0]!.result).toMatchObject({ reason: 'fact_mismatch' });
  expect(run.modelCalls().every((c) => c.task === 'agent_weekly' && c.valid)).toBe(true);
  expect(run.agentScriptProblems()).toEqual([]);
}, 60_000);
