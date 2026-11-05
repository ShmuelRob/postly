/**
 * The scripted agent in an end-to-end run (WP-91; agent.md, Testing without paying for a model).
 * The agent runtime is WP-90, so the app here is a stub with a minimal turn loop written in this
 * file: it builds the AgentContext, asks the model for a step, checks and runs each tool call the
 * way agent.md describes (a refused call stops the step and goes back to the agent), and reports
 * the turn. The model is the model simulator playing a script; nothing here can reach a real model.
 */
import { expect } from 'vitest';
import { AgentContext, AgentStep, type AgentToolCall } from '../../src/contracts/agent.js';
import type { ModelProvider, PaymentProvider, PublishingProvider, TemplateRenderer } from '../../src/contracts/providers/index.js';
import { MessagingSimulator } from '../../src/simulators/messaging.js';
import { ModelSimulator, taskOutputJsonSchema } from '../../src/simulators/model.js';
import { type AgentTurnReport, call, step } from '../../src/simulators/scripted-agent.js';
import { e2eTest, type AppFactory } from './harness/index.js';

const OWNER = '+972501234567';
const BUSINESS = '+972501234562';

const notUsed = (what: string) => () => Promise.reject(new Error(`${what} is not used in this test`));
const publishing = { name: 'unused', createConnectionLink: notUsed('publishing'), getConnectionStatus: notUsed('publishing'), publish: notUsed('publishing'), getPublicationStatus: notUsed('publishing'), getMetrics: notUsed('publishing'), disconnectAccount: notUsed('publishing'), testSchedule: notUsed('publishing') } satisfies PublishingProvider;
const payment = { name: 'unused', createPaymentLink: notUsed('payment'), getSubscriptionStatus: notUsed('payment'), cancelSubscription: notUsed('payment') } satisfies PaymentProvider;
const renderer = { render: notUsed('renderer') } satisfies TemplateRenderer;

type Result = AgentContext['toolResults'][number]['result'];

/**
 * Stub app: every owner text starts one weekly-agent turn. Facts must quote the owner's words
 * verbatim, and ask_owner is sent as a WhatsApp text. Stands in for WP-90 only to exercise the harness.
 */
function stubAgentApp(onTurnEnd: (turn: AgentTurnReport) => void): AppFactory {
  return ({ messaging, model }) => {
    const owner: string[] = [];
    const facts: { id: string; type: string; value: string; sourceQuote: string }[] = [];
    let turns = 0;

    const run = async (callToRun: AgentToolCall): Promise<Result> => {
      switch (callToRun.tool) {
        case 'record_fact': {
          if (!owner.some((text) => text.includes(callToRun.sourceQuote))) {
            return { status: 'refused', reason: 'quote_not_found', detail: `"${callToRun.sourceQuote}" is not in the owner's messages` };
          }
          const id = `f${facts.length + 1}`;
          facts.push({ id, type: callToRun.type, value: callToRun.value, sourceQuote: callToRun.sourceQuote });
          return { status: 'ok', data: { factId: id } };
        }
        case 'ask_owner':
          await messaging.sendText({ to: OWNER, text: callToRun.text });
          return { status: 'ok', data: {} };
        case 'end_turn':
          return { status: 'ok', data: {} };
        default:
          return { status: 'refused', reason: 'not_allowed', detail: `${callToRun.tool} is not allowed in this stub` };
      }
    };

    return {
      async deliverInbound(message) {
        if (message.content.kind !== 'text') return;
        owner.push(message.content.text);
        const report: AgentTurnReport = { agent: 'weekly', businessId: 'stub-business', turnId: `turn-${++turns}`, stopReason: 'max_steps', steps: [] };
        const toolResults: AgentContext['toolResults'] = [];
        for (let i = 0; i < 6; i++) {
          const input = AgentContext.parse({
            agent: 'weekly',
            persona: { name: 'פוסטלי', gender: 'feminine' },
            languages: ['he'],
            tone: { register: 'warm', address: 'plural', emoji: true },
            profile: { name: 'הפרחים של רינה' },
            missingFields: [],
            messages: owner.map((text) => ({ role: 'owner', text, at: message.receivedAt, photos: [] })),
            step: 'processing_update',
            openQuestion: null,
            week: { updateText: owner[0], facts, declines: [] },
            posts: [],
            rules: [],
            history: [],
            tools: ['ask_owner', 'record_fact', 'end_turn'],
            doneRule: 'Every fact a post needs is recorded',
            budget: { stepsLeft: 6 - i, costLeftUsd: 0.06 },
            toolResults,
          });
          const { output } = await model.generateStructured({
            task: 'agent_weekly',
            model: 'simulator-model',
            prompt: 'agent_weekly v1',
            input,
            outputJsonSchema: taskOutputJsonSchema('agent_weekly'),
            temperature: 0,
          });
          const agentStep = AgentStep.parse(output);
          const done = { calls: [] as AgentToolCall[], results: [] as AgentTurnReport['steps'][number]['results'] };
          report.steps.push(done);
          let stop: AgentTurnReport['stopReason'] | undefined;
          done.calls.push(...agentStep.calls);
          for (const c of agentStep.calls) {
            const result = await run(c);
            done.results.push(result);
            toolResults.push({ tool: c.tool, result });
            if (result.status === 'refused') {
              // The later calls of the step never run.
              done.results.push(...agentStep.calls.slice(done.results.length).map(() => null));
              break;
            }
            if (c.tool === 'end_turn') stop = 'end_turn';
            if (c.tool === 'ask_owner' && c.expects === 'answer') stop = 'waiting_for_owner';
          }
          if (stop) {
            report.stopReason = stop;
            break;
          }
        }
        onTurnEnd(report);
      },
    };
  };
}

e2eTest('a scripted weekly agent asks for a missing end date, and a refused quote goes back to it', async ({ e2e }) => {
  const update = 'השבוע 20% הנחה על כל זרי הסתיו';
  const answer = 'עד יום חמישי';
  const model = new ModelSimulator();
  model.scriptAgent(
    'weekly',
    // Turn 1: a quote that is not in the message is refused; the agent corrects it and asks one question.
    [
      step(call.recordFact({ type: 'discount_percent', value: '20', sourceQuote: '20% הנחה על הכל' })),
      step(call.recordFact({ type: 'discount_percent', value: '20', sourceQuote: '20% הנחה על כל זרי הסתיו' })),
      step(call.askOwner('עד מתי המבצע?', { topic: 'detail:date' })),
    ],
    // Turn 2: the answer becomes a fact, and the turn ends.
    [step(call.recordFact({ type: 'date', value: 'יום חמישי', sourceQuote: answer }), call.endTurn())],
  );

  let run: Awaited<ReturnType<typeof e2e.start>> | undefined;
  run = await e2e.start({
    providers: { messaging: new MessagingSimulator(), model: model satisfies ModelProvider, publishing, payment, renderer },
    app: stubAgentApp((turn) => run!.recordAgentTurn(turn)),
    ownerPhone: OWNER,
    businessPhone: BUSINESS,
  });

  await run.owner.sendsText(update);
  expect(run.owner.received().map((m) => m.text)).toEqual(['עד מתי המבצע?']);

  await run.owner.sendsText(answer);
  expect(run.owner.received()).toHaveLength(1);

  // What the report shows: every step, its tool calls, and what code answered.
  expect(model.agentSteps.map((s) => [s.turn, s.step, s.calls?.map((c) => c.tool), s.results.map((r) => r.result.status)])).toEqual([
    [1, 1, ['record_fact'], ['refused']],
    [1, 2, ['record_fact'], ['ok']],
    [1, 3, ['ask_owner'], []],
    [2, 1, ['record_fact', 'end_turn'], []],
  ]);
  expect(model.agentSteps[0]?.results[0]?.result).toMatchObject({ reason: 'quote_not_found' });
  expect(run.modelCalls().every((c) => c.task === 'agent_weekly' && c.valid)).toBe(true);
  expect(run.agentScriptProblems()).toEqual([]);
}, 30_000);
