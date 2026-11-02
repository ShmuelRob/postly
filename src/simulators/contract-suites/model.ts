import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Language } from '../../contracts/common.js';
import { modelTasks } from '../../contracts/model-tasks.js';
import { type ModelProvider, StructuredResult, TranscriptionResult } from '../../contracts/providers/model.js';

export interface ModelContractContext {
  provider: ModelProvider;
  /** The model id to call, as model_task_config would name it. */
  model: string;
  /** A photo the provider can fetch. */
  imageUrl: string;
  /** A short voice note the provider can fetch, in `audioLanguage`. */
  audioUrl: string;
  audioLanguage: z.infer<typeof Language>;
}

/**
 * The behavior every ModelProvider must share; WP-41 runs it against the real
 * adapter. A real model may still fail a task schema now and then, which is
 * why the model layer retries; this suite uses the simplest tasks.
 */
export function describeModelProviderContract(
  label: string,
  makeContext: () => ModelContractContext | Promise<ModelContractContext>,
): void {
  describe(`ModelProvider contract: ${label}`, () => {
    let ctx: ModelContractContext;
    beforeEach(async () => {
      ctx = await makeContext();
    });

    it('has a name', () => {
      expect(ctx.provider.name.length).toBeGreaterThan(0);
    });

    it('returns structured output with usage for generateStructured', async () => {
      const task = modelTasks.intent_detection;
      const result = await ctx.provider.generateStructured({
        model: ctx.model,
        prompt: 'Classify the intent of the owner message.',
        input: task.input.parse({ text: 'יש לנו מבצע השבוע', step: 'idle', draftsOpen: false }),
        outputJsonSchema: z.toJSONSchema(task.output),
        temperature: 0,
      });
      expect(StructuredResult.safeParse(result).success).toBe(true);
      expect(task.output.safeParse(result.output).success).toBe(true);
    });

    it('returns structured output with usage for analyzeImage', async () => {
      const task = modelTasks.image_review;
      const result = await ctx.provider.analyzeImage({
        model: ctx.model,
        prompt: 'Review this photo for use in a post.',
        imageUrl: ctx.imageUrl,
        outputJsonSchema: z.toJSONSchema(task.output),
      });
      expect(StructuredResult.safeParse(result).success).toBe(true);
      expect(task.output.safeParse(result.output).success).toBe(true);
    });

    it('transcribes audio', async () => {
      const result = await ctx.provider.transcribeAudio({
        model: ctx.model,
        audioUrl: ctx.audioUrl,
        languageHint: ctx.audioLanguage,
      });
      expect(TranscriptionResult.safeParse(result).success).toBe(true);
    });

    it('rejects a request outside the contract shape', async () => {
      await expect(
        ctx.provider.generateStructured({
          model: ctx.model,
          prompt: '',
          input: {},
          outputJsonSchema: {},
          temperature: 0,
        }),
      ).rejects.toThrow();
    });
  });
}
