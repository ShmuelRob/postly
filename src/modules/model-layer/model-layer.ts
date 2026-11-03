import { performance } from 'node:perf_hooks';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type ModelTaskInput, type ModelTaskName, type ModelTaskOutput, modelTasks } from '../../contracts/model-tasks.js';
import type { ModelProvider, StructuredResult } from '../../contracts/providers/model.js';
import type { Database } from '../../db/index.js';
import { consoleItem, modelRun, modelTaskConfig, promptTemplate } from '../../db/schema.js';

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
type Attempt = { result?: StructuredResult; output?: unknown; valid: boolean; error?: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
        const t = await provider.transcribeAudio({ model, audioUrl, languageHint });
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
    return { result, valid: false, error: z.prettifyError(check.error) };
  }

  return {
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
      const maxCost = Number(config.maxCostUsd);
      const runIds: string[] = [];
      const errors: string[] = [];
      let spent = 0;
      let target = primary;

      for (let n = 1; n <= config.maxRetries + 1; n++) {
        const started = performance.now();
        const outcome = await attempt(businessId, task, parsedInput, config, template.template, target);
        const rejected = outcome.valid && options.check ? options.check(outcome.output as never) : null;
        if (rejected !== null) Object.assign(outcome, { valid: false, error: `code check: ${rejected}` });
        const durationMs = Math.round(performance.now() - started);
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
            })
            .returning({ id: modelRun.id }),
        );
        runIds.push(...rows.map((r) => r.id));
        if (outcome.valid) return outcome.output as ModelTaskOutput<typeof task>;

        errors.push(outcome.error ?? 'invalid output');
        spent += outcome.result?.costUsd ?? 0;
        if (spent >= maxCost) {
          errors.push(`cost limit reached: ${spent.toFixed(6)} of ${maxCost.toFixed(6)} USD`);
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
      throw new ModelTaskFailedError(task, runIds.length, item.id, errors.at(-1) ?? 'invalid output');
    },
  };
}
