import { describe, expect, it } from 'vitest';
import type { AgentContext, AgentToolCall, AgentToolResult } from '../contracts/agent.js';
import { type ModelTaskName, modelTasks } from '../contracts/model-tasks.js';
import { ModelSimulator, taskOutputJsonSchema } from './model.js';
import {
  ScriptedAgentError,
  call,
  invalidOutput,
  providerFailure,
  step,
  stepWith,
  stepFrom,
} from './scripted-agent.js';

// The scripted agent (agent.md, Testing without paying for a model; WP-91): each agent_* task
// returns the next AgentStep of a script the test supplies, turn by turn, and anything off script
// fails the test.

const POST = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

function context(agent: AgentContext['agent'], toolResults: AgentContext['toolResults'] = []): AgentContext {
  return {
    agent,
    persona: { name: 'פוסטלי', gender: 'feminine' },
    languages: ['he'],
    tone: { register: 'warm', address: 'plural', emoji: true },
    profile: { name: 'פרחי דנה' },
    missingFields: [],
    messages: [{ role: 'owner', text: 'השבוע 20% הנחה על תמרים', at: '2026-11-05T10:00:00+02:00', photos: [] }],
    step: 'processing_update',
    openQuestion: null,
    week: { updateText: 'השבוע 20% הנחה על תמרים', facts: [], declines: [] },
    posts: [],
    rules: [],
    history: [],
    tools: ['ask_owner', 'record_fact', 'plan_posts', 'hand_off_to_console', 'end_turn'],
    doneRule: 'Done when the plan passed the checks',
    budget: { stepsLeft: 12, costLeftUsd: 0.06 },
    toolResults,
  };
}

const taskOf = { onboarding: 'agent_onboarding', weekly: 'agent_weekly', drafts: 'agent_drafts' } as const;

function ask(sim: ModelSimulator, input: AgentContext | Record<string, unknown>, task: ModelTaskName = taskOf[(input as AgentContext).agent]) {
  return sim.generateStructured({
    task,
    model: 'simulator-model',
    prompt: `${task} v1`,
    input,
    outputJsonSchema: taskOutputJsonSchema(task),
    temperature: 0,
  });
}

const ok = (data: Record<string, unknown> = {}): AgentToolResult => ({ status: 'ok', data });
const result = (tool: AgentToolCall['tool'], r: AgentToolResult) => ({ tool, result: r });

const recordDates = call.recordFact({ type: 'discount_percent', value: '20', sourceQuote: '20% הנחה על תמרים' });
const askEnd = call.askOwner('עד מתי המבצע?', { topic: 'detail:date' });

describe('the script builder', () => {
  it('builds tool calls that pass the AgentToolCall schema, with defaults for the optional fields', () => {
    expect(call.askOwner('מה שם העסק?')).toEqual({ tool: 'ask_owner', text: 'מה שם העסק?', topic: 'info', expects: 'answer' });
    expect(call.askOwner('תודה!', { expects: 'none' })).toMatchObject({ expects: 'none' });
    expect(call.endTurn()).toEqual({ tool: 'end_turn' });
    expect(call.handOff('unclear', 'לא ברור')).toEqual({ tool: 'hand_off_to_console', reason: 'unclear', note: 'לא ברור' });
    expect(call.requestPhoto('post', 'יש תמונה של התמרים?', POST)).toEqual({
      tool: 'request_photo',
      purpose: 'post',
      text: 'יש תמונה של התמרים?',
      postId: POST,
    });
  });

  it('refuses a step that the AgentStep schema refuses, when the script is written', () => {
    expect(() => step()).toThrow();
    expect(() => step(call.endTurn(), call.endTurn(), call.endTurn(), call.endTurn(), call.endTurn())).toThrow();
    expect(() => stepWith(1.5, call.endTurn())).toThrow();
    expect(() => step({ tool: 'approve', postId: POST } as unknown as AgentToolCall)).toThrow();
  });
});

describe('ModelSimulator: the scripted agent', () => {
  it('plays a turn step by step and starts the next turn when the tool results are empty again', async () => {
    const sim = new ModelSimulator();
    sim.scriptAgent('weekly', [step(recordDates), step(askEnd)], [step(call.endTurn())]);

    expect((await ask(sim, context('weekly'))).output).toEqual({ calls: [recordDates], confidence: 0.9 });
    const afterFact = [result('record_fact', ok({ factId: 'f1' }))];
    expect((await ask(sim, context('weekly', afterFact))).output).toEqual({ calls: [askEnd], confidence: 0.9 });
    expect((await ask(sim, context('weekly'))).output).toEqual({ calls: [call.endTurn()], confidence: 0.9 });

    expect(sim.agentScriptProblems()).toEqual([]);
  });

  it('builds a stepFrom entry from the context it answers, such as a photo id the test cannot know', async () => {
    const sim = new ModelSimulator();
    sim.scriptAgent('weekly', [stepFrom((ctx) => ({ calls: [call.askOwner(ctx.persona.name + ', ' + ctx.messages.length)], confidence: 0.8 }))]);
    expect((await ask(sim, context('weekly'))).output).toEqual({ calls: [call.askOwner('פוסטלי, 1')], confidence: 0.8 });
    expect(sim.agentSteps[0]).toMatchObject({ turn: 1, step: 1, calls: [call.askOwner('פוסטלי, 1')] });
    expect(sim.agentScriptProblems()).toEqual([]);
  });

  it('records every step with its turn, its calls, and the results the runtime passed back', async () => {
    const sim = new ModelSimulator();
    sim.scriptAgent('weekly', [step(recordDates), step(askEnd)]);
    await ask(sim, context('weekly'));
    await ask(sim, context('weekly', [result('record_fact', ok({ factId: 'f1' }))]));

    expect(sim.agentSteps).toEqual([
      { agent: 'weekly', turn: 1, step: 1, calls: [recordDates], confidence: 0.9, results: [result('record_fact', ok({ factId: 'f1' }))] },
      { agent: 'weekly', turn: 1, step: 2, calls: [askEnd], confidence: 0.9, results: [] },
    ]);
  });

  it('keeps the scripts of different agents apart', async () => {
    const sim = new ModelSimulator();
    const askName = call.askOwner('מה שם העסק?', { topic: 'profile:name', fields: ['name'] });
    sim.scriptAgent('onboarding', [step(askName)]);
    sim.scriptAgent('weekly', [step(call.endTurn())]);

    expect((await ask(sim, context('weekly'))).output).toMatchObject({ calls: [call.endTurn()] });
    expect((await ask(sim, context('onboarding'))).output).toMatchObject({ calls: [askName] });
    expect(sim.agentScriptProblems()).toEqual([]);
  });

  it('serves a scripted invalid output and then the retry from the same turn', async () => {
    const sim = new ModelSimulator();
    sim.scriptAgent('weekly', [invalidOutput({ calls: [] }), step(askEnd)], [step(call.endTurn())]);

    expect((await ask(sim, context('weekly'))).output).toEqual({ calls: [] });
    // The model layer retries with the same input: still turn 1.
    expect((await ask(sim, context('weekly'))).output).toMatchObject({ calls: [askEnd] });
    expect((await ask(sim, context('weekly'))).output).toMatchObject({ calls: [call.endTurn()] });
    expect(sim.agentSteps.map((s) => [s.turn, s.step])).toEqual([[1, 1], [1, 2], [2, 1]]);
    expect(sim.agentScriptProblems()).toEqual([]);
  });

  it('throws a scripted provider failure, and the retry takes the next entry of the turn', async () => {
    const sim = new ModelSimulator();
    sim.scriptAgent('weekly', [providerFailure('quota'), step(askEnd)]);

    await expect(ask(sim, context('weekly'))).rejects.toThrow('quota');
    expect((await ask(sim, context('weekly'))).output).toMatchObject({ calls: [askEnd] });
    expect(sim.agentScriptProblems()).toEqual([]);
  });

  it('fails when the script runs out, and keeps the violation for the harness', async () => {
    const sim = new ModelSimulator();
    sim.scriptAgent('weekly', [step(recordDates)]);
    await ask(sim, context('weekly'));

    await expect(ask(sim, context('weekly', [result('record_fact', ok({ factId: 'f1' }))]))).rejects.toThrow(ScriptedAgentError);
    await expect(ask(sim, context('weekly'))).rejects.toThrow(/weekly.*turn 2/);
    expect(sim.agentScriptProblems()).toHaveLength(2);
  });

  it('fails a call to an agent with no script once the test scripted any agent', async () => {
    const sim = new ModelSimulator();
    sim.scriptAgent('weekly', [step(call.endTurn())]);

    await expect(ask(sim, context('drafts'))).rejects.toThrow(/drafts.*no script/);
    expect(sim.agentScriptProblems()).toEqual([expect.stringMatching(/drafts/), expect.stringMatching(/weekly.*unused/)]);
  });

  it('reports a turn that ended with scripted steps left over', async () => {
    const sim = new ModelSimulator();
    sim.scriptAgent('weekly', [step(recordDates), step(askEnd)], [step(call.endTurn())]);
    await ask(sim, context('weekly'));
    // The runtime ended turn 1 after one step and started a new turn.
    await ask(sim, context('weekly'));

    expect(sim.agentScriptProblems()).toEqual([expect.stringMatching(/weekly turn 1 ended with 1 unused step/)]);
  });

  it('reports turns never reached', () => {
    const sim = new ModelSimulator();
    sim.scriptAgent('drafts', [step(call.endTurn())], [step(call.endTurn())]);
    expect(sim.agentScriptProblems()).toEqual([expect.stringMatching(/drafts.*2 unused step/)]);
  });

  it('fails a context that is not an AgentContext', async () => {
    const sim = new ModelSimulator();
    sim.scriptAgent('weekly', [step(call.endTurn())]);
    await expect(ask(sim, { agent: 'weekly' }, 'agent_weekly')).rejects.toThrow(/not an AgentContext/);
    expect(sim.agentScriptProblems()[0]).toMatch(/not an AgentContext/);
  });

  it('fails a continued step when no turn of that agent started', async () => {
    const sim = new ModelSimulator();
    sim.scriptAgent('weekly', [step(call.endTurn())]);
    await expect(ask(sim, context('weekly', [result('end_turn', ok())]))).rejects.toThrow(/no turn started/);
  });

  it('strictAgents: an agent call with no script fails even when no agent was scripted', async () => {
    const sim = new ModelSimulator({ strictAgents: true });
    await expect(ask(sim, context('weekly'))).rejects.toThrow(/weekly.*no script/);
    expect(sim.agentScriptProblems()).toEqual([expect.stringMatching(/weekly/)]);
  });

  it('without any agent script, an agent call still hands off (WP-89 default) and is no violation', async () => {
    const sim = new ModelSimulator();
    const output = modelTasks.agent_weekly.output.parse((await ask(sim, context('weekly'))).output);
    expect(output.calls.map((c) => c.tool)).toEqual(['hand_off_to_console']);
    expect(sim.agentScriptProblems()).toEqual([]);
  });

  it('a per-task script(...) still comes first, for model-layer tests', async () => {
    const sim = new ModelSimulator();
    sim.scriptAgent('weekly', [step(askEnd)]);
    sim.script('agent_weekly', { calls: [call.endTurn()], confidence: 0.2 });
    expect((await ask(sim, context('weekly'))).output).toEqual({ calls: [call.endTurn()], confidence: 0.2 });
    expect((await ask(sim, context('weekly'))).output).toMatchObject({ calls: [askEnd] });
  });
});
