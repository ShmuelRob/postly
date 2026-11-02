import { z } from 'zod';
import { Language, Url } from '../common.js';

const usage = {
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  costUsd: z.number().min(0),
};

export const GenerateStructuredRequest = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  input: z.unknown(),
  /** JSON schema of the task output, generated from the task's Zod schema. */
  outputJsonSchema: z.record(z.string(), z.unknown()),
  temperature: z.number().min(0).max(2),
});
export type GenerateStructuredRequest = z.infer<typeof GenerateStructuredRequest>;

export const AnalyzeImageRequest = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  imageUrl: Url,
  outputJsonSchema: z.record(z.string(), z.unknown()),
});
export type AnalyzeImageRequest = z.infer<typeof AnalyzeImageRequest>;

/** Raw output; only the model layer validates it against the task schema. */
export const StructuredResult = z.object({ output: z.unknown(), ...usage });
export type StructuredResult = z.infer<typeof StructuredResult>;

export const TranscribeAudioRequest = z.object({ model: z.string().min(1), audioUrl: Url, languageHint: Language });
export type TranscribeAudioRequest = z.infer<typeof TranscribeAudioRequest>;

export const TranscriptionResult = z.object({ text: z.string(), language: Language, costUsd: usage.costUsd });
export type TranscriptionResult = z.infer<typeof TranscriptionResult>;

/** The only code that knows a model vendor implements this. Called only by the model layer. */
export interface ModelProvider {
  readonly name: string;
  generateStructured(request: GenerateStructuredRequest): Promise<StructuredResult>;
  analyzeImage(request: AnalyzeImageRequest): Promise<StructuredResult>;
  transcribeAudio(request: TranscribeAudioRequest): Promise<TranscriptionResult>;
}
