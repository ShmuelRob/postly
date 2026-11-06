/**
 * Agent runtime (WP-90, agent.md: Runtime, Tools, Limits). A scripted agent (the model simulator
 * playing fixed agent steps; no real model) runs real turns over the real messaging module and
 * database: its question reaches the owner, a closed 24-hour window refuses a message, and a limit
 * hands the conversation to a person with an `agent_limit` console item that shows the turn's
 * steps. The routing from the workflow to the agent is a stub here until WP-92 to WP-94 wire it.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, expect, inject } from 'vitest';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { createAgent, handOffLine, type Agent } from '../../src/modules/agent/index.js';
import { createConsole } from '../../src/modules/console/index.js';
import { createMessaging } from '../../src/modules/messaging/index.js';
import { createModelLayer } from '../../src/modules/model-layer/index.js';
import { createWorkflow } from '../../src/modules/workflow/index.js';
import { MessagingSimulator, ModelSimulator, PaymentSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { call, step, stepWith } from '../../src/simulators/scripted-agent.js';
import { e2eTest, type AppFactory, type E2eRun, type Providers } from './harness/index.js';

const OWNER = '+972501234590';
const BUSINESS_PHONE = '+972521111190';
const QUESTION = 'עד מתי בתוקף ה-15% הנחה על הוורדים?';

const db = createDatabase(inject('databaseUrls'), { max: 3 });
afterAll(() => db.close());
const workflow = createWorkflow(db, { rejected: () => {} });
const consoleService = createConsole(db, workflow);

async function newBusiness(): Promise<string> {
  const businessId = randomUUID();
  await db.withSystem('console', (tx) => tx.update(schema.business).set({ approverPhone: `+9720${Date.now()}` }).where(eq(schema.business.approverPhone, OWNER)));
  await db.withBusiness('workflow', businessId, async (tx) => {
    await tx.insert(schema.business).values({ id: businessId, name: 'פרחי דנה', status: 'active', approverPhone: OWNER, profile: { name: 'פרחי דנה', approverPhone: OWNER } });
    await tx.insert(schema.conversationState).values({ businessId, step: 'processing_update' });
  });
  return businessId;
}

e2eTest('a scripted agent asks the owner, a closed window refuses a message, and a limit hands off with the turn in the console', async ({ e2e }) => {
  const businessId = await newBusiness();
  const model = new ModelSimulator({ defaults: false, strictAgents: true });
  // Turn 1, on the owner's update: one question. Turn 2, a day later: a message the closed window
  // refuses, then end the turn. Turn 3: a step below the confidence floor, which hands off.
  model.scriptAgent(
    'weekly',
    [step(call.askOwner(QUESTION, { topic: 'detail:date' }))],
    [step(call.askOwner('עוד משהו לפני שאני מכינה טיוטות?', { topic: 'anything_else' })), step(call.endTurn())],
    [stepWith(0.1, call.endTurn())],
  );
  const providers = {
    messaging: new MessagingSimulator({ businessNumber: BUSINESS_PHONE }),
    publishing: new PublishingSimulator(),
    model,
    payment: new PaymentSimulator(),
    renderer: { render: async () => ({}) },
  } satisfies Providers;

  let clock = Date.now();
  const now = () => new Date(clock);
  const questions: string[] = [];
  let agent!: Agent;
  let run!: E2eRun;
  let flush = async () => {};
  const app: AppFactory = ({ messaging: provider, model: recorded }) => {
    const messaging = createMessaging({
      db,
      provider,
      businessNumber: BUSINESS_PHONE,
      now,
      // Stub routing until WP-93: every burst runs a weekly-agent turn.
      handler: { handleInbound: async (burst) => void (await agent.runTurn(burst.businessId, 'weekly', { kind: 'burst', messageIds: burst.messages.map((m) => m.id) })) },
    });
    agent = createAgent({
      db,
      models: createModelLayer({ db, providers: { google: recorded } }),
      messaging,
      events: { questionAsked: async (_b, q) => void questions.push(q.key) },
      now,
      // Every turn, with its last step's results and its stop reason, goes into the e2e report.
      onTurnEnd: (turn) => run.recordAgentTurn(turn),
    });
    flush = () => messaging.flushBursts();
    return { deliverInbound: async (message) => void (await messaging.receive(message)) };
  };
  run = await e2e.start({ providers, app, ownerPhone: OWNER, businessPhone: BUSINESS_PHONE });

  // 1. The owner's update starts a turn; the agent's question reaches the owner.
  await run.owner.sendsText('השבוע 15% הנחה על ורדים');
  await flush();
  expect(run.owner.received().map((m) => m.text)).toEqual([QUESTION]);
  expect(questions).toEqual(['detail:date']);

  // 2. A day later the window is closed: the agent's next message is refused, nothing is sent.
  clock += 25 * 3600_000;
  const second = await agent.runTurn(businessId, 'weekly', { kind: 'event', name: 'e2e' });
  expect(second).toMatchObject({ status: 'done', stopReason: 'end_turn' });
  expect(run.owner.received()).toHaveLength(1);

  // 3. A step below the confidence floor hands off; the console shows the item and the turns.
  clock += 60_000;
  const third = await agent.runTurn(businessId, 'weekly', { kind: 'event', name: 'e2e' });
  expect(third).toMatchObject({ status: 'handed_off', stopReason: 'low_confidence' });
  const items = (await consoleService.openItems()).filter((i) => i.businessId === businessId);
  expect(items).toEqual([expect.objectContaining({ kind: 'agent_limit', referenceId: third.turnId, details: expect.objectContaining({ reason: 'low_confidence' }) })]);
  const turns = await consoleService.agentTurns(businessId);
  expect(turns.map((t) => [t.status, t.stopReason])).toEqual([
    ['handed_off', 'low_confidence'],
    ['done', 'end_turn'],
    ['waiting', 'waiting_for_owner'],
  ]);
  expect(turns[1]!.steps).toMatchObject([{ calls: [{ result: { status: 'refused', reason: 'window_closed' } }] }, { calls: [{ result: { status: 'ok' } }] }]);
  // The window is closed, so even the hand-off line waits for the owner; a person picks it up from the console.
  expect(run.owner.received().map((m) => m.text)).not.toContain(handOffLine('פוסטלי', 'he'));
  // The report has the three turns as the runtime reported them, and the scripts ran exactly.
  expect(run.modelCalls().every((c) => c.task === 'agent_weekly')).toBe(true);
  expect(model.agentSteps.map((s) => [s.turn, s.step])).toEqual([[1, 1], [2, 1], [2, 2], [3, 1]]);
  expect(run.agentScriptProblems()).toEqual([]);
});
