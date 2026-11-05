import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Language } from '../contracts/common.js';
import {
  type ModelTaskInput,
  type ModelTaskName,
  type ModelTaskOutput,
  modelTasks,
} from '../contracts/model-tasks.js';
import {
  AnalyzeImageRequest,
  GenerateStructuredRequest,
  type ModelProvider,
  type StructuredResult,
  TranscribeAudioRequest,
  type TranscriptionResult,
} from '../contracts/providers/model.js';
import type { AgentName } from '../contracts/agent.js';
import { defaultOutput } from './model-fixtures.js';
import { type AgentStepRecord, ScriptedAgent, type ScriptTurn, agentOfTask } from './scripted-agent.js';

/**
 * The JSON schema of a task's output. Requests name their task, and the
 * simulator checks that `outputJsonSchema` equals this for that task.
 */
export function taskOutputJsonSchema(task: ModelTaskName): Record<string, unknown> {
  return z.toJSONSchema(modelTasks[task].output) as Record<string, unknown>;
}

export type Fixture<T extends ModelTaskName> = ModelTaskOutput<T> | ((input: ModelTaskInput<T>) => ModelTaskOutput<T>);

type Scripted =
  | { kind: 'valid'; fixture: Fixture<ModelTaskName> }
  | { kind: 'raw'; output: unknown }
  | { kind: 'error'; error: Error };

export type ModelCall =
  | { method: 'generateStructured'; task: ModelTaskName; request: GenerateStructuredRequest; result?: StructuredResult }
  | { method: 'analyzeImage'; task: ModelTaskName; request: AnalyzeImageRequest; result?: StructuredResult }
  | { method: 'transcribeAudio'; request: TranscribeAudioRequest; result: TranscriptionResult };

type Transcript = { text: string; language: z.infer<typeof Language> };

export interface ModelSimulatorOptions {
  /** When false, a call with nothing scripted throws instead of using the default fixture. */
  defaults?: boolean;
  /**
   * Strict agents: an agent task call with no `scriptAgent` script for its agent fails the test
   * (a violation), even when the test scripted no agent at all. Without it, an unscripted agent
   * hands off until the first `scriptAgent` call (review of #117).
   */
  strictAgents?: boolean;
}

const COST_PER_TOKEN_USD = 0.000001;
const tokens = (value: unknown) => Math.max(1, Math.ceil((JSON.stringify(value) ?? '').length / 4));

/**
 * Scripted model vendor. Per task, outputs are served from a queue (valid
 * fixtures, invalid raw output, or errors), then from input-aware defaults.
 * Every call is recorded with its task, request, and result.
 */
export class ModelSimulator implements ModelProvider {
  readonly name = 'simulator';
  readonly calls: ModelCall[] = [];

  private readonly useDefaults: boolean;
  private readonly queues = new Map<ModelTaskName, Scripted[]>();
  private readonly overrides = new Map<ModelTaskName, Fixture<ModelTaskName>>();
  private readonly transcriptQueue: Transcript[] = [];
  private readonly transcriptsByUrl = new Map<string, Transcript>();
  private readonly agent: ScriptedAgent;

  constructor(options: ModelSimulatorOptions = {}) {
    this.useDefaults = options.defaults ?? true;
    this.agent = new ScriptedAgent(options.strictAgents ?? false);
  }

  async generateStructured(request: GenerateStructuredRequest): Promise<StructuredResult> {
    const parsed = GenerateStructuredRequest.parse(request);
    const call: ModelCall = { method: 'generateStructured', task: this.taskOf(parsed.task, parsed.outputJsonSchema), request: parsed };
    this.calls.push(call);
    call.result = this.respond(call.task, parsed.input);
    return call.result;
  }

  async analyzeImage(request: AnalyzeImageRequest): Promise<StructuredResult> {
    const parsed = AnalyzeImageRequest.parse(request);
    const call: ModelCall = { method: 'analyzeImage', task: this.taskOf(parsed.task, parsed.outputJsonSchema), request: parsed };
    this.calls.push(call);
    call.result = this.respond(call.task, { imageUrl: parsed.imageUrl });
    return call.result;
  }

  async transcribeAudio(request: TranscribeAudioRequest): Promise<TranscriptionResult> {
    const parsed = TranscribeAudioRequest.parse(request);
    const transcript = this.transcriptsByUrl.get(parsed.audioUrl) ??
      this.transcriptQueue.shift() ?? {
        text: defaultOutput('transcription', undefined).text,
        language: parsed.languageHint,
      };
    const result = { ...transcript, costUsd: 0.001 };
    this.calls.push({ method: 'transcribeAudio', request: parsed, result });
    return result;
  }

  /** Queues outputs for a task, used once each in order. Each must be valid against the task schema. */
  script<T extends ModelTaskName>(task: T, ...fixtures: Fixture<T>[]): void {
    for (const fixture of fixtures) {
      if (typeof fixture !== 'function') modelTasks[task].output.parse(fixture);
      this.queue(task).push({ kind: 'valid', fixture: fixture as Fixture<ModelTaskName> });
    }
  }

  /**
   * Scripts an agent turn by turn (agent.md, Testing without paying for a model): each call of its
   * agent_* task returns the next entry of the current turn, and a call with empty `toolResults`
   * starts the next turn. Once any agent is scripted, a call to an agent with no script, a script
   * that runs out, or a turn left with unused steps is a violation (`agentScriptProblems()`).
   */
  scriptAgent(agent: AgentName, ...turns: ScriptTurn[]): void {
    this.agent.script(agent, turns);
  }

  /** Every scripted agent step served, with the tool results the runtime passed back after it. */
  get agentSteps(): AgentStepRecord[] {
    return this.agent.steps;
  }

  /** Off-script calls and scripted steps never played; the e2e harness fails a test on any. */
  agentScriptProblems(): string[] {
    return this.agent.problems();
  }

  /** Queues raw output returned as is, for validation and retry tests. */
  scriptInvalid(task: ModelTaskName, ...outputs: unknown[]): void {
    for (const output of outputs) this.queue(task).push({ kind: 'raw', output });
  }

  /** Queues a provider failure (timeout, quota) for the next call of this task. */
  failNext(task: ModelTaskName, error: Error = new Error('Simulated model failure')): void {
    this.queue(task).push({ kind: 'error', error });
  }

  /** Replaces the default fixture for a task, for every unscripted call. */
  setDefault<T extends ModelTaskName>(task: T, fixture: Fixture<T>): void {
    if (typeof fixture !== 'function') modelTasks[task].output.parse(fixture);
    this.overrides.set(task, fixture as Fixture<ModelTaskName>);
  }

  /** The output an unscripted call returns for this input. */
  defaultOutput<T extends ModelTaskName>(task: T, input: unknown): ModelTaskOutput<T> {
    const override = this.overrides.get(task);
    if (override) return this.resolve(task, override, input) as ModelTaskOutput<T>;
    return defaultOutput(task, input);
  }

  /** The transcript for one audio url, for every call. */
  setTranscript(audioUrl: string, transcript: Transcript): void {
    this.transcriptsByUrl.set(audioUrl, transcript);
  }

  /** Queues transcripts for audio urls without a fixed transcript. */
  scriptTranscription(...transcripts: Transcript[]): void {
    this.transcriptQueue.push(...transcripts);
  }

  callsFor(task: ModelTaskName): ModelCall[] {
    return this.calls.filter((c) => c.method !== 'transcribeAudio' && c.task === task);
  }

  private respond(task: ModelTaskName, input: unknown): StructuredResult {
    const next = this.queue(task).shift();
    if (next?.kind === 'error') throw next.error;
    let output: unknown;
    const agent = agentOfTask(task);
    if (next?.kind === 'raw') output = next.output;
    else if (next?.kind === 'valid') output = this.resolve(task, next.fixture, input);
    else if (agent && (this.agent.has(agent) || (this.agent.active && !this.overrides.has(task)))) output = this.agent.respond(agent, input);
    else if (this.useDefaults || this.overrides.has(task)) output = this.defaultOutput(task, input);
    else throw new Error(`No scripted output for model task ${task}`);

    const inputTokens = tokens(input);
    const outputTokens = tokens(output);
    return { output, inputTokens, outputTokens, costUsd: (inputTokens + outputTokens) * COST_PER_TOKEN_USD };
  }

  private resolve(task: ModelTaskName, fixture: Fixture<ModelTaskName>, input: unknown): unknown {
    if (typeof fixture !== 'function') return structuredClone(fixture);
    const parsedInput = modelTasks[task].input.parse(input);
    return modelTasks[task].output.parse((fixture as (i: unknown) => unknown)(parsedInput));
  }

  private taskOf(task: ModelTaskName, outputJsonSchema: Record<string, unknown>): ModelTaskName {
    if (!isDeepStrictEqual(taskOutputJsonSchema(task), outputJsonSchema)) {
      throw new Error(`The output JSON schema does not match task ${task}`);
    }
    return task;
  }

  private queue(task: ModelTaskName): Scripted[] {
    let queue = this.queues.get(task);
    if (!queue) this.queues.set(task, (queue = []));
    return queue;
  }
}
