import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { setLogSink } from '../../shared/logger.js';
import type { AgentContext, AgentStep } from '../../contracts/agent.js';
import { type SendTextRequest, WindowClosedError } from '../../contracts/providers/messaging.js';
import { createDatabase } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { ModelSimulator } from '../../simulators/model.js';
import { createModelLayer, type ModelLayer } from '../model-layer/index.js';
import { createAgent, handOffLine, type AgentDeps } from './index.js';
import { weeklyAgent } from './agents/weekly.js';
import { agents as agentRegistry } from './agents/index.js';
import { handOff } from './handoff.js';

// The agent runtime (WP-90, agent.md: Runtime, Limits, Tools) against the migrated database and the
// model simulator with scripted agent steps. No test calls a real model.

const db = createDatabase(inject('databaseUrls'), { max: 3 });
afterAll(() => db.close());

const OWNER_TEXT = 'השבוע 15% הנחה על ורדים עד יום חמישי';

let businessId: string;
let approver: string;
let sim: ModelSimulator;
let models: ModelLayer;
let sent: SendTextRequest[];
let windowOpen: boolean;
let questions: { key: string; askedFields: string[]; postId?: string }[];

const messaging: AgentDeps['messaging'] = {
  async sendText(_businessId, request) {
    if (!windowOpen) throw new WindowClosedError(request.to, null);
    sent.push(request);
    return { providerMessageId: randomUUID() };
  },
};
const events: AgentDeps['events'] = { questionAsked: async (_b, q) => void questions.push(q) };
const agentWith = (overrides: Partial<AgentDeps> = {}) => createAgent({ db, models, messaging, events, ...overrides });

const step = (calls: AgentStep['calls'], confidence = 0.9): AgentStep => ({ calls, confidence });
const ask = (text: string, topic = 'detail:date', expects: 'answer' | 'none' = 'answer') => ({ tool: 'ask_owner' as const, text, topic, expects });
const decline = (ownerQuote = 'עד יום חמישי') => ({ tool: 'record_decline' as const, what: 'anything_else', ownerQuote });
const END = { tool: 'end_turn' as const };
const trigger = { kind: 'event', name: 'test' } as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function newBusiness(): Promise<void> {
  businessId = randomUUID();
  approver = `+9725${Math.floor(1e7 + Math.random() * 9e7)}`;
  await db.withBusiness('workflow', businessId, async (tx) => {
    await tx.insert(schema.business).values({
      id: businessId,
      name: 'פרחי דנה',
      status: 'active',
      approverPhone: approver,
      profile: { name: 'פרחי דנה', approverPhone: approver, contact: { phone: '+972501234567' } },
    });
    await tx.insert(schema.conversationState).values({ businessId, step: 'processing_update' });
  });
  await db.withBusiness('messaging', businessId, (tx) =>
    tx.insert(schema.message).values({
      businessId,
      direction: 'inbound',
      kind: 'text',
      provider: 'sim',
      providerMessageId: randomUUID(),
      fromPhone: approver,
      toPhone: '+972500000000',
      body: OWNER_TEXT,
    }),
  );
}

const turnRow = (turnId: string) =>
  db.withBusiness('workflow', businessId, async (tx) => (await tx.select().from(schema.agentTurn).where(eq(schema.agentTurn.id, turnId)))[0]!);
const consoleItems = () => db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.consoleItem).where(eq(schema.consoleItem.businessId, businessId)));
const handoffAt = () =>
  db.withBusiness('workflow', businessId, async (tx) => (await tx.select().from(schema.conversationState).where(eq(schema.conversationState.businessId, businessId)))[0]!.handoffAt);
const contextOf = (n: number, task: 'agent_weekly' | 'agent_onboarding' = 'agent_weekly') => sim.callsFor(task)[n]!.request as unknown as { input: AgentContext };

const DEFAULT_LIMITS = { maxSteps: 12, maxToolCalls: 24, maxRefusals: 3, maxRepeatedQuestions: 3, minConfidence: 0.4, timeoutMs: 90_000 };
const setLimits = (values: Partial<typeof schema.agentConfig.$inferInsert>) =>
  db.withSystem('console', (tx) => tx.update(schema.agentConfig).set(values).where(eq(schema.agentConfig.agent, 'onboarding')));

beforeEach(async () => {
  await newBusiness();
  sim = new ModelSimulator({ defaults: false });
  models = createModelLayer({ db, providers: { google: sim } });
  sent = [];
  windowOpen = true;
  questions = [];
});
afterEach(() => setLimits(DEFAULT_LIMITS));

describe('a turn', () => {
  it('sends a question to the approver, waits for the answer, and records the turn', async () => {
    sim.script('agent_weekly', step([ask('עד מתי המבצע של 15%?')]));
    const result = await agentWith().runTurn(businessId, 'weekly', { kind: 'burst', messageIds: [] });

    expect(result).toMatchObject({ status: 'waiting', stopReason: 'waiting_for_owner' });
    expect(sent).toEqual([{ to: approver, text: 'עד מתי המבצע של 15%?' }]);
    expect(questions).toEqual([{ agent: 'weekly', key: 'detail:date', askedFields: [] }]);
    const turn = await turnRow(result.turnId!);
    expect(turn).toMatchObject({ agent: 'weekly', status: 'waiting', stopReason: 'waiting_for_owner', trigger: { kind: 'burst', messageIds: [] } });
    expect(turn.steps).toMatchObject([{ confidence: 0.9, calls: [{ call: { tool: 'ask_owner' }, result: { status: 'ok' } }] }]);
    expect(Number(turn.costUsd)).toBeGreaterThan(0);
    expect(turn.endedAt).not.toBeNull();
    const runs = await db.withBusiness('model', businessId, (tx) => tx.select().from(schema.modelRun).where(eq(schema.modelRun.businessId, businessId)));
    expect(runs.map((r) => [r.task, r.agentTurnId])).toEqual([['agent_weekly', result.turnId]]);
  });

  it('reports each finished turn to onTurnEnd, with every call and its result', async () => {
    const ends: unknown[] = [];
    sim.script('agent_weekly', step([decline(), END]));
    const result = await agentWith({ onTurnEnd: (t) => void ends.push(t) }).runTurn(businessId, 'weekly', trigger);
    expect(ends).toEqual([
      {
        agent: 'weekly',
        businessId,
        turnId: result.turnId,
        stopReason: 'end_turn',
        steps: [{ calls: [decline(), END], results: [expect.objectContaining({ status: 'ok' }), expect.objectContaining({ status: 'ok' })] }],
      },
    ]);
  });

  // docs/observability.md, Timing lines: one `agent step` line per step and one `agent turn ended` per turn.
  it('logs each step and the turn with their durations and counts, and none of the text', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      sim.script('agent_weekly', step([decline(), ask('עד מתי המבצע של 15%?', 'detail:date', 'none')]), step([END]));
      await agentWith().runTurn(businessId, 'weekly', trigger);
    } finally {
      setLogSink(undefined);
    }
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const steps = parsed.filter((l) => l.message === 'agent step');
    expect(steps).toEqual([
      expect.objectContaining({ agent: 'weekly', step: 1, tools: 'record_decline,ask_owner', modelMs: expect.any(Number), toolsMs: expect.any(Number) }),
      expect.objectContaining({ step: 2, tools: 'end_turn' }),
    ]);
    const [ended] = parsed.filter((l) => l.message === 'agent turn ended');
    expect(ended).toMatchObject({ agent: 'weekly', trigger: 'event:test', status: 'done', stopReason: 'end_turn', steps: 2, toolCalls: 3, durationMs: expect.any(Number), costUsd: expect.any(Number) });
    expect(lines.join('\n')).not.toContain('המבצע');
  });

  it('builds the context from this business only, with the persona and without the approver number', async () => {
    sim.script('agent_weekly', step([END]));
    await agentWith().runTurn(businessId, 'weekly', trigger);
    const { input } = contextOf(0);
    expect(input.persona).toEqual({ name: 'פוסטלי', gender: 'feminine' });
    expect(input.messages).toEqual([expect.objectContaining({ role: 'owner', text: OWNER_TEXT })]);
    // The running agent's own tool list (the weekly agent's grew with WP-93).
    expect(input.tools).toEqual([...weeklyAgent.tools]);
    expect(JSON.stringify(input)).not.toContain(approver);
  });

  it('a closed window refuses the message, and the refusal goes back to the agent', async () => {
    windowOpen = false;
    sim.script('agent_weekly', step([ask('עד מתי המבצע?')]), step([END]));
    const result = await agentWith().runTurn(businessId, 'weekly', trigger);
    expect(result).toMatchObject({ status: 'done', stopReason: 'end_turn' });
    expect(sent).toEqual([]);
    expect(contextOf(1).input.toolResults).toEqual([{ tool: 'ask_owner', result: expect.objectContaining({ status: 'refused', reason: 'window_closed' }) }]);
  });

  it('a refused call changes nothing and skips the rest of its step', async () => {
    sim.script('agent_weekly', step([decline('ציטוט שלא נשלח'), ask('עוד משהו?', 'anything_else', 'none')]), step([END]));
    await agentWith().runTurn(businessId, 'weekly', trigger);
    expect(sent).toEqual([]);
    expect(contextOf(1).input.toolResults).toEqual([{ tool: 'record_decline', result: expect.objectContaining({ reason: 'quote_not_found' }) }]);
  });

  it('refuses a tool the agent may not use, and one whose package has not landed', async () => {
    sim.script(
      'agent_weekly',
      step([{ tool: 'record_fact', type: 'discount_percent', value: '15', sourceQuote: '15% הנחה' }]),
      step([END]),
    );
    await agentWith().runTurn(businessId, 'weekly', trigger);
    expect(contextOf(1).input.toolResults[0]!.result).toMatchObject({ status: 'refused', reason: 'not_allowed' });
  });

  it('refuses text with a number that has no source, a link, or approval language', async () => {
    sim.script('agent_weekly', step([ask('המחיר 39 ש"ח?', 'detail:price')]), step([ask('ראית את www.example.com?', 'info', 'none')]), step([ask('הפוסט אושר!', 'info', 'none')]));
    const result = await agentWith().runTurn(businessId, 'weekly', trigger);
    // Three refusals reach the limit: only the hand-off line goes out.
    expect(result.stopReason).toBe('refusals');
    expect(sent).toEqual([{ to: approver, text: handOffLine('פוסטלי', 'he') }]);
    const turn = await turnRow(result.turnId!);
    expect((turn.steps as { calls: { result: { reason: string } }[] }[]).map((st) => st.calls[0]!.result.reason)).toEqual([
      'fact_mismatch',
      'forbidden_content',
      'forbidden_content',
    ]);
  });

  it('accepts numbers the owner wrote', async () => {
    sim.script('agent_weekly', step([ask('ה-15% הנחה בתוקף עד יום חמישי?')]));
    expect(await agentWith().runTurn(businessId, 'weekly', trigger)).toMatchObject({ status: 'waiting' });
  });

  it('sends at most two messages and one question a turn', async () => {
    sim.script('agent_weekly', step([ask('קיבלתי, תודה', 'info', 'none'), ask('רגע אחד', 'info', 'none'), ask('ועוד אחת', 'info', 'none')]), step([END]));
    await agentWith().runTurn(businessId, 'weekly', trigger);
    expect(sent).toHaveLength(2);
    expect(contextOf(1).input.toolResults.at(-1)!.result).toMatchObject({ reason: 'question_limit' });
  });

  it('hand_off_to_console sets the handoff, opens a console item and tells the owner', async () => {
    sim.script('agent_weekly', step([{ tool: 'hand_off_to_console', reason: 'owner_asked_for_person', note: 'ביקש נציג' }]));
    const result = await agentWith().runTurn(businessId, 'weekly', trigger);
    expect(result).toMatchObject({ status: 'handed_off', stopReason: 'handed_off' });
    expect(await handoffAt()).not.toBeNull();
    expect(await consoleItems()).toEqual([
      expect.objectContaining({ kind: 'handoff', referenceId: result.turnId, details: expect.objectContaining({ reason: 'owner_asked_for_person', note: 'ביקש נציג' }) }),
    ]);
    expect(sent).toEqual([{ to: approver, text: handOffLine('פוסטלי', 'he') }]);
  });
});

describe('one turn per business', () => {
  it('runs nothing while another turn runs, or while a person handles the conversation', async () => {
    await db.withBusiness('workflow', businessId, (tx) => tx.insert(schema.agentTurn).values({ businessId, agent: 'weekly', trigger }));
    expect(await agentWith().runTurn(businessId, 'weekly', trigger)).toEqual({ turnId: null, status: 'skipped', stopReason: null, messagesSent: 0 });

    await newBusiness();
    await db.withBusiness('workflow', businessId, (tx) =>
      tx.update(schema.conversationState).set({ handoffAt: new Date() }).where(eq(schema.conversationState.businessId, businessId)),
    );
    expect(await agentWith().runTurn(businessId, 'weekly', trigger)).toMatchObject({ status: 'skipped' });
    expect(sim.callsFor('agent_weekly')).toHaveLength(0);
  });

  it('of two turns started at once, exactly one runs (the conversation_state row lock)', async () => {
    sim.script('agent_weekly', step([END]));
    // A slow step keeps the first turn running while the second one tries the lock.
    const slow = { ...models, run: (async (...args: Parameters<ModelLayer['run']>) => (await sleep(300), models.run(...args))) as ModelLayer['run'] };
    const agent = agentWith({ models: slow });
    const results = await Promise.all([agent.runTurn(businessId, 'weekly', trigger), agent.runTurn(businessId, 'weekly', trigger)]);
    expect(results.map((r) => r.status).sort()).toEqual(['done', 'skipped']);
    expect(sim.callsFor('agent_weekly')).toHaveLength(1);
    const turns = await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.agentTurn).where(eq(schema.agentTurn.businessId, businessId)));
    expect(turns).toHaveLength(1);
  });

  it('closes a crashed turn (running for twice the timeout) and runs', async () => {
    const [stale] = await db.withBusiness('workflow', businessId, (tx) =>
      tx.insert(schema.agentTurn).values({ businessId, agent: 'weekly', trigger, startedAt: new Date(Date.now() - 200_000) }).returning(),
    );
    sim.script('agent_weekly', step([END]));
    expect(await agentWith().runTurn(businessId, 'weekly', trigger)).toMatchObject({ status: 'done' });
    expect((await turnRow(stale!.id)).status).toBe('failed');
  });
});

// agent.md, Runtime ("No silent turn"): the 2026-11-06 sandbox turn that ended with end_turn and said nothing.
describe('end_turn and the owner who waits for a reply', () => {
  const doneWeekly = (done: boolean) => ({ ...weeklyAgent, isDone: async () => done });
  const withDone = (done: boolean) => agentWith({ agents: { ...agentRegistry, weekly: doneWeekly(done) } });

  it('evaluates the done rule after end_turn, so a turn whose work is done ends done', async () => {
    sim.script('agent_weekly', step([END]));
    const result = await withDone(true).runTurn(businessId, 'weekly', trigger, { mustReply: true });
    expect(result).toMatchObject({ status: 'done', stopReason: 'done', messagesSent: 0 });
    expect(await consoleItems()).toHaveLength(0);
  });

  it('hands off with the line when a turn the owner waits on ends with nothing sent and not done', async () => {
    sim.script('agent_weekly', step([END]));
    const result = await withDone(false).runTurn(businessId, 'weekly', { kind: 'burst', messageIds: [] }, { mustReply: true });
    expect(result).toMatchObject({ status: 'handed_off', stopReason: 'end_turn', messagesSent: 0 });
    expect(sent).toEqual([{ to: approver, text: handOffLine('פוסטלי', 'he') }]);
    expect(await handoffAt()).not.toBeNull();
    expect(await consoleItems()).toEqual([expect.objectContaining({ kind: 'agent_limit', referenceId: result.turnId, details: expect.objectContaining({ reason: 'silent_turn' }) })]);
    expect((await turnRow(result.turnId!)).status).toBe('handed_off');
  });

  it('does not hand off when the turn sent the owner a message, or when the caller replies itself', async () => {
    sim.script('agent_weekly', step([ask('קיבלתי, תודה!', 'info', 'none'), END]));
    expect(await withDone(false).runTurn(businessId, 'weekly', trigger, { mustReply: true })).toMatchObject({ status: 'done', stopReason: 'end_turn', messagesSent: 1 });
    sim.script('agent_weekly', step([END]));
    expect(await withDone(false).runTurn(businessId, 'weekly', trigger)).toMatchObject({ status: 'done', stopReason: 'end_turn', messagesSent: 0 });
    expect(await consoleItems()).toHaveLength(0);
  });

  // docs/observability.md, "Following one message": a hand-off logs its kind and reason code, never free text.
  it('logs each hand-off with its kind and reason code, and drops a reason that is not a code word', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      const turnId = randomUUID();
      await handOff({ db, messaging }, { businessId, turnId, kind: 'agent_limit', details: { reason: 'max_steps', agent: 'onboarding' }, approverPhone: approver, personaName: 'פוסטלי', language: 'he', now: new Date() });
      await handOff({ db, messaging }, { businessId, turnId, kind: 'handoff', details: { reason: 'הלקוח כועס מאוד' }, approverPhone: approver, personaName: 'פוסטלי', language: 'he', now: new Date() });
      await handOff({ db, messaging }, { businessId, turnId, kind: 'agent_limit', details: { reason: 'error', error: 'Error: boom' }, approverPhone: approver, personaName: 'פוסטלי', language: 'he', now: new Date() });
    } finally {
      setLogSink(undefined);
    }
    const handoffs = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.message === 'agent hand-off');
    expect(handoffs.map((l) => [l.severity, l.kind, l.reason, l.agent])).toEqual([
      ['WARNING', 'agent_limit', 'max_steps', 'onboarding'],
      ['WARNING', 'handoff', undefined, undefined],
      ['ERROR', 'agent_limit', 'error', undefined],
    ]);
    expect(lines.join(' ')).not.toContain('הלקוח כועס');
    expect(lines.join(' ')).not.toContain(approver);
  });

  it('the hand-off line reaches the approver even when the turn never read the context', async () => {
    await handOff(
      { db, messaging },
      { businessId, turnId: randomUUID(), kind: 'agent_limit', details: { reason: 'error' }, approverPhone: '', personaName: 'פוסטלי', language: 'he', now: new Date() },
    );
    expect(sent).toEqual([{ to: approver, text: handOffLine('פוסטלי', 'he') }]);
  });
});

// agent.md, Limits: every limit ends the turn and hands off, with an agent_limit console item.
describe('limits', () => {
  async function expectLimit(reason: string, run: Promise<{ turnId: string | null; status: string; stopReason: string | null }>) {
    const result = await run;
    expect(result).toMatchObject({ status: 'handed_off', stopReason: reason });
    expect(await handoffAt()).not.toBeNull();
    expect(await consoleItems()).toContainEqual(expect.objectContaining({ kind: 'agent_limit', referenceId: result.turnId, details: expect.objectContaining({ reason }) }));
    expect(sent.at(-1)).toEqual({ to: approver, text: handOffLine('פוסטלי', 'he') });
    expect((await turnRow(result.turnId!)).status).toBe('handed_off');
  }

  it('max_steps', async () => {
    await setLimits({ maxSteps: 2 });
    sim.script('agent_onboarding', step([decline()]), step([decline()]), step([END]));
    await expectLimit('max_steps', agentWith().runTurn(businessId, 'onboarding', trigger));
    expect(sim.callsFor('agent_onboarding')).toHaveLength(2);
  });

  it('max_tool_calls', async () => {
    await setLimits({ maxToolCalls: 3 });
    sim.script('agent_onboarding', step([decline(), decline(), decline(), decline()]));
    await expectLimit('max_tool_calls', agentWith().runTurn(businessId, 'onboarding', trigger));
  });

  it('low_confidence runs none of the step calls', async () => {
    sim.script('agent_onboarding', step([ask('עוד משהו?', 'anything_else', 'none')], 0.2));
    await expectLimit('low_confidence', agentWith().runTurn(businessId, 'onboarding', trigger));
    expect(sent).toHaveLength(1); // only the hand-off line
  });

  it('refusals', async () => {
    sim.script('agent_onboarding', step([decline('לא נשלח')]), step([decline('לא נשלח')]), step([decline('לא נשלח')]));
    await expectLimit('refusals', agentWith().runTurn(businessId, 'onboarding', trigger));
  });

  it('stuck: the same question asked too many times in scope', async () => {
    await setLimits({ maxRepeatedQuestions: 1 });
    sim.script('agent_onboarding', step([ask('עד מתי המבצע?')]));
    await agentWith().runTurn(businessId, 'onboarding', trigger);
    sim.script('agent_onboarding', step([ask('אז עד מתי המבצע?')]));
    await expectLimit('stuck', agentWith().runTurn(businessId, 'onboarding', trigger));
  });

  it('timeout', async () => {
    let clock = Date.now();
    const now = () => new Date((clock += 60_000));
    sim.script('agent_onboarding', step([decline()]), step([END]));
    await expectLimit('timeout', agentWith({ now }).runTurn(businessId, 'onboarding', trigger));
  });

  it('timeout bounds a model call that hangs: the turn ends, the lock frees, and the late answer does nothing', async () => {
    await setLimits({ timeoutMs: 1_000 });
    let answer: ((s: AgentStep) => void) | undefined;
    const hanging = { ...models, run: (() => new Promise<AgentStep>((resolve) => (answer = resolve))) as unknown as ModelLayer['run'] };
    const started = Date.now();
    await expectLimit('timeout', agentWith({ models: hanging }).runTurn(businessId, 'onboarding', trigger));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(answer, 'the model call started').toBeDefined();

    // The call answers after the turn ended: none of its tools run.
    answer!(step([ask('עוד משהו?', 'anything_else', 'none')]));
    await sleep(50);
    expect(sent).toHaveLength(1); // only the hand-off line

    // The turn is closed, so once a person clears the handoff the next turn runs at once.
    await db.withBusiness('workflow', businessId, (tx) =>
      tx.update(schema.conversationState).set({ handoffAt: null }).where(eq(schema.conversationState.businessId, businessId)),
    );
    sim.script('agent_onboarding', step([END]));
    expect(await agentWith().runTurn(businessId, 'onboarding', trigger)).toMatchObject({ status: 'done' });
  });

  it('timeout is also checked after each tool call: the rest of the step does not run', async () => {
    let clock = Date.now();
    const now = () => new Date(clock);
    // Sending takes longer than the whole 90-second turn.
    const slowSend: AgentDeps['messaging'] = {
      async sendText(b, request) {
        clock += 100_000;
        return messaging.sendText(b, request);
      },
    };
    sim.script('agent_onboarding', step([ask('קיבלתי', 'info', 'none'), ask('ועוד משהו', 'info', 'none')]));
    await expectLimit('timeout', agentWith({ now, messaging: slowSend }).runTurn(businessId, 'onboarding', trigger));
    expect(sent.map((m) => m.text)).toEqual(['קיבלתי', handOffLine('פוסטלי', 'he')]);
  });

  it('global_budget logs the one alert line the monitoring counts', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      const overGlobal = { ...models, spentByAllSince: async () => 49.99 };
      await expectLimit('global_budget', agentWith({ models: overGlobal }).runTurn(businessId, 'onboarding', trigger));
    } finally {
      setLogSink(undefined);
    }
    const alerts = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.message === 'agent global budget reached');
    expect(alerts).toEqual([expect.objectContaining({ severity: 'WARNING', capUsd: 50, agent: 'onboarding' })]);
    expect(alerts[0]!['logging.googleapis.com/labels']).toMatchObject({ businessId });
  });

  it('invalid_output after the model layer gives up', async () => {
    sim.scriptInvalid('agent_onboarding', { calls: [{ tool: 'approve' }] }, { calls: [] }, {});
    await expectLimit('invalid_output', agentWith().runTurn(businessId, 'onboarding', trigger));
    expect(await consoleItems()).toContainEqual(expect.objectContaining({ kind: 'model_validation_failed' }));
  });

  it('turn_budget: a step starts only when the turn can still pay its full cap', async () => {
    sim.script('agent_onboarding', step([decline()]), step([decline()]), step([decline()]), step([END]));
    // Each step spends its whole 0.02 cap here: three steps fit the 0.06 turn, a fourth does not start.
    const fullSteps = { ...models, spentOnTurn: async () => 0.02 * sim.callsFor('agent_onboarding').length };
    await expectLimit('turn_budget', agentWith({ models: fullSteps }).runTurn(businessId, 'onboarding', trigger));
    expect(sim.callsFor('agent_onboarding')).toHaveLength(3);
  });

  it('daily_budget and global_budget are checked before the first step', async () => {
    const overDaily = { ...models, spentSince: async () => 0.99 };
    await expectLimit('daily_budget', agentWith({ models: overDaily }).runTurn(businessId, 'onboarding', trigger));
    await newBusiness();
    const overGlobal = { ...models, spentByAllSince: async () => 49.99 };
    await expectLimit('global_budget', agentWith({ models: overGlobal }).runTurn(businessId, 'onboarding', trigger));
    expect(sim.callsFor('agent_onboarding')).toHaveLength(0);
  });
});

describe('the hand-off line', () => {
  it("is in the business's first language, with the persona's name in that language", async () => {
    await db.withBusiness('workflow', businessId, (tx) =>
      tx.update(schema.business).set({ profile: { name: 'Dana Flowers', approverPhone: approver, languages: ['en'] } }).where(eq(schema.business.id, businessId)),
    );
    sim.script('agent_weekly', step([{ tool: 'hand_off_to_console', reason: 'owner_asked_for_person', note: 'asked for a person' }]));
    await agentWith().runTurn(businessId, 'weekly', trigger);
    expect(sent).toEqual([{ to: approver, text: handOffLine('Postly', 'en') }]);
  });
});

describe('module direction (agent.md)', () => {
  it('the agent module never imports workflow', () => {
    const dir = new URL('./', import.meta.url);
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    for (const file of files) expect(readFileSync(new URL(file.replaceAll('\\', '/'), dir), 'utf8'), file).not.toMatch(/from '[./]*\/workflow\//);
  });
});
