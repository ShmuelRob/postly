import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Language } from '../contracts/common.js';
import {
  MODEL_TASK_NAMES,
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
import { defaultOutput } from './model-fixtures.js';

/**
 * The JSON schema the simulator expects for a task's output. The simulator
 * identifies the task by matching the request's `outputJsonSchema` against
 * this, so the model layer must derive it the same way.
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
  private readonly schemas = MODEL_TASK_NAMES.map((task) => ({ task, schema: taskOutputJsonSchema(task) }));

  constructor(options: ModelSimulatorOptions = {}) {
    this.useDefaults = options.defaults ?? true;
  }

  async generateStructured(request: GenerateStructuredRequest): Promise<StructuredResult> {
    const parsed = GenerateStructuredRequest.parse(request);
    const call: ModelCall = { method: 'generateStructured', task: this.taskOf(parsed.outputJsonSchema), request: parsed };
    this.calls.push(call);
    call.result = this.respond(call.task, parsed.input);
    return call.result;
  }

  async analyzeImage(request: AnalyzeImageRequest): Promise<StructuredResult> {
    const parsed = AnalyzeImageRequest.parse(request);
    const call: ModelCall = { method: 'analyzeImage', task: this.taskOf(parsed.outputJsonSchema), request: parsed };
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
    if (next?.kind === 'raw') output = next.output;
    else if (next?.kind === 'valid') output = this.resolve(task, next.fixture, input);
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

  private taskOf(outputJsonSchema: Record<string, unknown>): ModelTaskName {
    const match = this.schemas.find((s) => isDeepStrictEqual(s.schema, outputJsonSchema));
    if (!match) throw new Error('Unknown model task: the output JSON schema matches no task in modelTasks');
    return match.task;
  }

  private queue(task: ModelTaskName): Scripted[] {
    let queue = this.queues.get(task);
    if (!queue) this.queues.set(task, (queue = []));
    return queue;
  }
}
