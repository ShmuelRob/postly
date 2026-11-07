import { performance } from 'node:perf_hooks';
import { and, eq, gte, sum } from 'drizzle-orm';
import { z } from 'zod';
import { type ModelTaskInput, type ModelTaskName, type ModelTaskOutput, modelTasks } from '../../contracts/model-tasks.js';
import type { ModelProvider, StructuredResult } from '../../contracts/providers/model.js';
import type { Database } from '../../db/index.js';
import { consoleItem, modelRun, modelTaskConfig, promptTemplate } from '../../db/schema.js';
import { errorText, log } from '../../shared/logger.js';
import { metrics, withSpan } from '../../shared/telemetry.js';

/** Resolves a business's media asset to a URL the model provider can fetch (voice notes, photos). */
export type MediaUrlResolver = (businessId: string, mediaAssetId: string) => Promise<string>;

export interface ModelLayerDeps {
  db: Database;
  /** Model providers by the name `model_task_config.provider` uses, for example `google`. */
  providers: Record<string, ModelProvider>;
  /** Needed only for `transcription` and `image_review`. */
  resolveMediaUrl?: MediaUrlResolver;
}

export interface RunOptions<Output = unknown> {
  /** The row the task is about (a message, weekly update, or post), stored on the console item. */
  referenceId?: string;
  /**
   * A code check the schema cannot express (contracts.md): returns null to accept the output or a
   * reason to reject it. A rejection counts as a failed attempt, like a schema failure.
   */
  check?: (output: Output) => string | null;
  /**
   * A caller's cap for this call, below `model_task_config.max_cost_usd` (agent.md, Limits): the
   * lower of the two caps every attempt of the call, retries included.
   */
  maxCostUsd?: number;
  /** The agent turn the call belongs to, stored on each `model_run` (WP-90). */
  agentTurnId?: string;
}

export interface ModelLayer {
  /**
   * Runs one model task for one business: the active prompt version and the model from
   * `model_task_config`, the task's output schema and code check, up to `max_retries` retries, and
   * one `model_run` row per attempt. Returns only output that passed both. After the last failed
   * attempt the task lands in `console_item` and this throws `ModelTaskFailedError`.
   */
  run<T extends ModelTaskName>(
    businessId: string,
    task: T,
    input: ModelTaskInput<T>,
    options?: RunOptions<ModelTaskOutput<T>>,
  ): Promise<ModelTaskOutput<T>>;
  /** The business's model spend in USD since a time, every task (agent.md, Limits). */
  spentSince(businessId: string, since: Date): Promise<number>;
  /** Every business's model spend in USD since a time, for the global daily cap. */
  spentByAllSince(since: Date): Promise<number>;
  /** The spend of one agent turn's model calls (`model_run.agent_turn_id`). */
  spentOnTurn(businessId: string, agentTurnId: string): Promise<number>;
  /** A task's `model_task_config.max_cost_usd`: what one call may spend, retries included. */
  costCap(businessId: string, task: ModelTaskName): Promise<number>;
}

/** Every attempt failed; a person picks the task up from the console. */
export class ModelTaskFailedError extends Error {
  constructor(
    readonly task: ModelTaskName,
    readonly attempts: number,
    readonly consoleItemId: string,
    readonly reason: string,
  ) {
    super(`Model task ${task} failed after ${attempts} attempt(s): ${reason}`);
    this.name = 'ModelTaskFailedError';
  }
}

type Config = typeof modelTaskConfig.$inferSelect;
type Target = { provider: string; model: string };
/** `invalidPaths`: the Zod issue paths of an invalid output, never its values (docs/observability.md). */
type Attempt = { result?: StructuredResult; output?: unknown; valid: boolean; error?: string; invalidPaths?: string };

type SchemaDef = { type?: string; shape?: Record<string, z.ZodType>; valueType?: z.ZodType; element?: z.ZodType; innerType?: z.ZodType; in?: z.ZodType; items?: z.ZodType[]; getter?: () => z.ZodType };
const defOf = (schema: z.ZodType | undefined): SchemaDef | undefined => (schema as unknown as { _zod?: { def?: SchemaDef } } | undefined)?._zod?.def;
const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'readonly', 'catch', 'nonoptional']);

/** One step down the schema along a path segment, and how to write that segment: a field name, `#` or `*`. */
function stepInto(schema: z.ZodType | undefined, segment: PropertyKey): { next: z.ZodType | undefined; written: string } {
  let def = defOf(schema);
  for (let i = 0; def && i < 10; i++) {
    if (def.type && WRAPPERS.has(def.type)) def = defOf(def.innerType);
    else if (def.type === 'pipe') def = defOf(def.in);
    else if (def.type === 'lazy' && def.getter) def = defOf(def.getter());
    else break;
  }
  if (typeof segment === 'number') return { next: def?.type === 'array' ? def.element : def?.type === 'tuple' ? def.items?.[segment] : undefined, written: '#' };
  const key = String(segment);
  if (def?.type === 'object' && def.shape && key in def.shape) return { next: def.shape[key], written: key };
  // A record key is what the model wrote, so it may be content; a key the schema cannot place is a
  // plain identifier at most.
  if (def?.type === 'record') return { next: def.valueType, written: '*' };
  return { next: undefined, written: /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(key) ? key : '*' };
}

/**
 * Where an output was invalid, for `invalidPaths` (docs/observability.md, Timing lines): the issue
 * paths as field names, array indexes as `#`, record keys as `*`, never the values.
 */
export function issuePaths(schema: z.ZodType, error: z.ZodError): string {
  const paths = error.issues.map((issue) => {
    if (issue.path.length === 0) return '(root)';
    let at: z.ZodType | undefined = schema;
    return issue.path
      .map((segment) => {
        const { next, written } = stepInto(at, segment);
        at = next;
        return written;
      })
      .join('.');
  });
  return [...new Set(paths)].join(',').slice(0, 200);
}

const attemptOutcome = (a: Attempt) => (a.valid ? 'valid' : a.result ? 'invalid' : 'provider_error');


export function createModelLayer(deps: ModelLayerDeps): ModelLayer {
  const providerNamed = (name: string): ModelProvider => {
    const found = deps.providers[name];
    if (!found) throw new Error(`No model provider named ${name}`);
    return found;
  };

  const mediaUrl = (businessId: string, assetId: string) => {
    if (!deps.resolveMediaUrl) throw new Error('resolveMediaUrl is required for media tasks');
    return deps.resolveMediaUrl(businessId, assetId);
  };

  async function attempt(
    businessId: string,
    task: ModelTaskName,
    input: unknown,
    config: Config,
    prompt: string,
    target: Target,
  ): Promise<Attempt> {
    const { model } = target;
    const outputJsonSchema = z.toJSONSchema(modelTasks[task].output) as Record<string, unknown>;
    let result: StructuredResult;
    try {
      const provider = providerNamed(target.provider);
      if (task === 'transcription') {
        const { voiceAssetId, languageHint } = input as ModelTaskInput<'transcription'>;
        const audioUrl = await mediaUrl(businessId, voiceAssetId);
        const t = await provider.transcribeAudio({ model, prompt, audioUrl, languageHint });
        result = { output: { text: t.text, language: t.language }, inputTokens: 0, outputTokens: 0, costUsd: t.costUsd };
      } else if (task === 'image_review') {
        const { mediaAssetId, purpose } = input as ModelTaskInput<'image_review'>;
        const imageUrl = await mediaUrl(businessId, mediaAssetId);
        result = await provider.analyzeImage({ task, model, prompt: `${prompt}\n\npurpose: ${purpose}`, imageUrl, outputJsonSchema });
      } else {
        result = await provider.generateStructured({ task, model, prompt, input, outputJsonSchema, temperature: config.temperature });
      }
    } catch (error) {
      return { valid: false, error: `provider error: ${errorText(error)}` };
    }
    const check = modelTasks[task].output.safeParse(result.output);
    if (check.success) return { result, output: check.data, valid: true };
    return { result, valid: false, error: z.prettifyError(check.error), invalidPaths: issuePaths(modelTasks[task].output, check.error) };
  }

  return {
    async spentSince(businessId, since) {
      const [row] = await deps.db.withBusiness('model', businessId, (tx) =>
        tx
          .select({ total: sum(modelRun.costUsd) })
          .from(modelRun)
          .where(and(eq(modelRun.businessId, businessId), gte(modelRun.createdAt, since))),
      );
      return Number(row?.total ?? 0);
    },
    async spentOnTurn(businessId, agentTurnId) {
      const [row] = await deps.db.withBusiness('model', businessId, (tx) =>
        tx
          .select({ total: sum(modelRun.costUsd) })
          .from(modelRun)
          .where(and(eq(modelRun.businessId, businessId), eq(modelRun.agentTurnId, agentTurnId))),
      );
      return Number(row?.total ?? 0);
    },
    async costCap(businessId, task) {
      const [row] = await deps.db.withBusiness('model', businessId, (tx) =>
        tx.select({ cap: modelTaskConfig.maxCostUsd }).from(modelTaskConfig).where(eq(modelTaskConfig.task, task)),
      );
      if (!row) throw new Error(`No model_task_config row for ${task}`);
      return Number(row.cap);
    },
    async spentByAllSince(since) {
      const [row] = await deps.db.withSystem('scheduler', (tx) =>
        tx.select({ total: sum(modelRun.costUsd) }).from(modelRun).where(gte(modelRun.createdAt, since)),
      );
      return Number(row?.total ?? 0);
    },
    async run(businessId, task, input, options = {}) {
      const parsedInput = modelTasks[task].input.parse(input);
      const { config, template } = await deps.db.withBusiness('model', businessId, async (tx) => {
        const [config] = await tx.select().from(modelTaskConfig).where(eq(modelTaskConfig.task, task));
        if (!config) throw new Error(`No model_task_config row for ${task}`);
        const [template] = await tx
          .select()
          .from(promptTemplate)
          .where(and(eq(promptTemplate.task, task), eq(promptTemplate.version, config.activePromptVersion)));
        if (!template) throw new Error(`No prompt_template for ${task} version ${config.activePromptVersion}`);
        return { config, template };
      });

      const primary: Target = { provider: config.provider, model: config.model };
      const fallback: Target | undefined = config.fallbackProvider
        ? { provider: config.fallbackProvider, model: config.fallbackModel ?? config.model }
        : undefined;
      const maxCost = Math.min(Number(config.maxCostUsd), options.maxCostUsd ?? Number.POSITIVE_INFINITY);
      const runIds: string[] = [];
      const errors: string[] = [];
      let spent = 0;
      let target = primary;
      // Why the task failed, for its log line: the last attempt's outcome and paths, or the cost cap.
      let lastFailure: { reason: 'invalid' | 'provider_error' | 'cost_limit'; invalidPaths?: string } = { reason: 'invalid' };

      for (let n = 1; n <= config.maxRetries + 1; n++) {
        const started = performance.now();
        const outcome = await withSpan(`model ${task}`, { task, attempt: n, businessId }, async (span) => {
          const result = await attempt(businessId, task, parsedInput, config, template.template, target);
          const rejected = result.valid && options.check ? options.check(result.output as never) : null;
          if (rejected !== null) Object.assign(result, { valid: false, error: `code check: ${rejected}` });
          span.set({ outcome: attemptOutcome(result) });
          return result;
        });
        const durationMs = Math.round(performance.now() - started);
        // docs/observability.md, Metrics: one call, its latency and its cost, by task.
        metrics.count('postly.model.calls.count', { task, outcome: attemptOutcome(outcome) });
        metrics.record('postly.model.latency', durationMs, { task, outcome: attemptOutcome(outcome) });
        if (outcome.result) metrics.count('postly.model.cost_usd', { task }, outcome.result.costUsd);
        // docs/observability.md, Timing lines: where a reply's time goes, with no input or output. An
        // invalid output or a provider error is retried, so it is a WARNING.
        (outcome.valid ? log.info : log.warn)('model call', {
          task,
          provider: target.provider,
          model: target.model,
          promptVersion: config.activePromptVersion,
          attempt: n,
          outcome: attemptOutcome(outcome),
          ...(outcome.invalidPaths ? { invalidPaths: outcome.invalidPaths } : {}),
          durationMs,
          inputTokens: outcome.result?.inputTokens,
          outputTokens: outcome.result?.outputTokens,
          thinkingTokens: outcome.result?.thinkingTokens,
          ...(options.agentTurnId ? { agentTurnId: options.agentTurnId } : {}),
        });
        const rows = await deps.db.withBusiness('model', businessId, (tx) =>
          tx
            .insert(modelRun)
            .values({
              businessId,
              task,
              promptVersion: template.version,
              provider: target.provider,
              model: target.model,
              attempt: n,
              input: parsedInput,
              output: outcome.result?.output ?? null,
              valid: outcome.valid,
              error: outcome.error ?? null,
              inputTokens: outcome.result?.inputTokens ?? null,
              outputTokens: outcome.result?.outputTokens ?? null,
              costUsd: outcome.result ? outcome.result.costUsd.toFixed(6) : null,
              durationMs,
              agentTurnId: options.agentTurnId ?? null,
            })
            .returning({ id: modelRun.id }),
        );
        runIds.push(...rows.map((r) => r.id));
        if (outcome.valid) return outcome.output as ModelTaskOutput<typeof task>;

        errors.push(outcome.error ?? 'invalid output');
        lastFailure = { reason: outcome.result ? 'invalid' : 'provider_error', ...(outcome.invalidPaths ? { invalidPaths: outcome.invalidPaths } : {}) };
        const last = outcome.result?.costUsd ?? 0;
        spent += last;
        // The cap counts every attempt: a retry starts only when it would stay within the cap,
        // judged by the last attempt's cost (agent.md, Limits).
        if (spent >= maxCost || (n <= config.maxRetries && spent + last > maxCost)) {
          errors.push(`cost limit reached: ${spent.toFixed(6)} of ${maxCost.toFixed(6)} USD`);
          lastFailure = { ...lastFailure, reason: 'cost_limit' };
          break;
        }
        // A provider failure (no output at all) moves the next attempt to the fallback, if any.
        if (!outcome.result && fallback) target = fallback;
      }

      const [item] = await deps.db.withBusiness('model', businessId, (tx) =>
        tx
          .insert(consoleItem)
          .values({
            businessId,
            kind: 'model_validation_failed',
            referenceId: options.referenceId ?? runIds.at(-1) ?? null,
            details: { task, promptVersion: template.version, attempts: runIds.length, modelRunIds: runIds, errors },
          })
          .returning({ id: consoleItem.id }),
      );
      if (!item) throw new Error('console_item insert returned no row');
      // docs/observability.md, "Following one message": a person must look, so ERROR; codes and paths only.
      log.error('model task failed', {
        businessId,
        task,
        promptVersion: template.version,
        attempts: runIds.length,
        ...lastFailure,
        consoleItemId: item.id,
        ...(options.agentTurnId ? { agentTurnId: options.agentTurnId } : {}),
      });
      throw new ModelTaskFailedError(task, runIds.length, item.id, errors.at(-1) ?? 'invalid output');
    },
  };
}
