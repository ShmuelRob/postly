// The Google model adapter: Gemini through Vertex AI (contracts.md, ModelProvider).
// It authenticates as the runtime service account (Application Default Credentials); there is no API key.
import { GoogleAuth } from 'google-auth-library';
import { Language } from '../../../contracts/common.js';
import {
  AnalyzeImageRequest,
  GenerateStructuredRequest,
  type ModelProvider,
  type StructuredResult,
  TranscribeAudioRequest,
  type TranscriptionResult,
} from '../../../contracts/providers/model.js';

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface VertexRequestBody {
  systemInstruction: { parts: Part[] };
  contents: { role: 'user'; parts: Part[] }[];
  generationConfig: {
    responseMimeType: 'application/json';
    responseJsonSchema?: Record<string, unknown>;
    /** Ignored by Gemini 3.5 Flash-Lite (fixed at 1.0); sent so a model that honors it does. */
    temperature: number;
    thinkingConfig?: { thinkingLevel: ThinkingLevel };
  };
}

/** Vertex's `generationConfig.thinkingConfig.thinkingLevel` values. */
export type ThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface VertexResponseBody {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  /** `thoughtsTokenCount` is the model's reasoning, billed at the output price. */
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

/** Posts one request to Vertex AI and returns the parsed response. Tests inject a fake. */
export type VertexTransport = (url: string, body: VertexRequestBody) => Promise<VertexResponseBody>;

/** Fetches a photo or voice note the adapter sends to the model as inline bytes. */
export type MediaFetcher = (url: string) => Promise<{ mimeType: string; data: Buffer }>;

interface Price {
  input: number;
  output: number;
}

interface ModelInfo {
  /** USD per million tokens on the `global` endpoint. */
  global: Price;
  /** USD per million tokens on any other endpoint: a multi-region such as `eu`, or a single region. */
  nonGlobal: Price;
  /** Takes `thinkingConfig.thinkingLevel` (Gemini 3 and later). */
  thinkingLevel: boolean;
}

/**
 * The models the adapter may call, with Vertex AI's standard pay-as-you-go prices for up to 200K input
 * tokens (https://cloud.google.com/vertex-ai/generative-ai/pricing, read 2026-11-06). The output price
 * covers the response and the reasoning. A model missing here is refused, so the Gemini 2.5 models
 * Vertex retired on 2026-10-20 can no longer be called.
 */
const MODELS: Record<string, ModelInfo> = {
  'gemini-3.5-flash-lite': { global: { input: 0.3, output: 2.5 }, nonGlobal: { input: 0.33, output: 2.75 }, thinkingLevel: true },
};

/**
 * Gemini 3.5 Flash-Lite thinks at MINIMAL by default, which Google warns can end multi-step tool use
 * early, so the tool-using agent tasks think at MEDIUM (agent.md, Running on dev). Other tasks keep the default.
 */
function thinkingLevelFor(task: string | undefined): ThinkingLevel | undefined {
  return task?.startsWith('agent_') ? 'MEDIUM' : undefined;
}

/** Vertex AI's multi-region locations, served from `aiplatform.<location>.rep.googleapis.com`. */
const MULTI_REGIONS = new Set(['eu', 'us']);

export interface VertexOptions {
  project: string;
  /** `global`, a multi-region (`eu`, `us`), or a single region such as `europe-west4`. */
  location: string;
  transport?: VertexTransport;
  fetchMedia?: MediaFetcher;
}

/** Application Default Credentials: the Cloud Run service account in GCP, `gcloud auth application-default login` locally. */
/**
 * True where no test or CI job may reach a paid model (agent.md, Testing without paying for a model):
 * Vitest sets NODE_ENV=test, and every CI job sets CI=true.
 */
export function realModelsRefused(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test' || env.CI === 'true';
}

export function adcTransport(env: NodeJS.ProcessEnv = process.env): VertexTransport {
  if (realModelsRefused(env)) throw new Error('Real Vertex AI calls are refused in tests and CI (agent.md, Testing without paying for a model)');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  return async (url, body) => {
    const client = await auth.getClient();
    const res = await client.request<VertexResponseBody>({ url, method: 'POST', data: body });
    return res.data;
  };
}

const fetchMediaOverHttp: MediaFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetching media failed with HTTP ${res.status}`);
  return {
    mimeType: res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
    data: Buffer.from(await res.arrayBuffer()),
  };
};

/** Vertex AI takes a subset of JSON Schema; drop the keys it does not accept. */
function forVertex(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

export class VertexModelProvider implements ModelProvider {
  readonly name = 'google';
  private readonly transport: VertexTransport;
  private readonly fetchMedia: MediaFetcher;

  constructor(private readonly options: VertexOptions) {
    this.transport = options.transport ?? adcTransport();
    this.fetchMedia = options.fetchMedia ?? fetchMediaOverHttp;
  }

  async generateStructured(request: GenerateStructuredRequest): Promise<StructuredResult> {
    const r = GenerateStructuredRequest.parse(request);
    return this.call(r.task, r.model, r.prompt, [{ text: JSON.stringify(r.input) }], r.outputJsonSchema, r.temperature);
  }

  async analyzeImage(request: AnalyzeImageRequest): Promise<StructuredResult> {
    const r = AnalyzeImageRequest.parse(request);
    const image = await this.inline(r.imageUrl);
    return this.call(r.task, r.model, r.prompt, [image], r.outputJsonSchema, 0);
  }

  async transcribeAudio(request: TranscribeAudioRequest): Promise<TranscriptionResult> {
    const r = TranscribeAudioRequest.parse(request);
    const audio = await this.inline(r.audioUrl);
    const schema = {
      type: 'object',
      properties: { text: { type: 'string' }, language: { type: 'string', enum: Language.options } },
      required: ['text', 'language'],
    };
    // The language hint is part of the input, so the versioned prompt stays the only instruction.
    const input = { text: `languageHint: ${r.languageHint}` };
    const result = await this.call(undefined, r.model, r.prompt, [input, audio], schema, 0);
    const output = result.output as { text: string; language: string };
    return { text: output.text, language: Language.parse(output.language), costUsd: result.costUsd };
  }

  private async inline(url: string): Promise<Part> {
    const media = await this.fetchMedia(url);
    return { inlineData: { mimeType: media.mimeType, data: media.data.toString('base64') } };
  }

  private url(model: string): string {
    const { project, location } = this.options;
    const host =
      location === 'global'
        ? 'aiplatform.googleapis.com'
        : MULTI_REGIONS.has(location)
          ? `aiplatform.${location}.rep.googleapis.com`
          : `${location}-aiplatform.googleapis.com`;
    return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
  }

  private async call(
    task: string | undefined,
    model: string,
    prompt: string,
    parts: Part[],
    schema: Record<string, unknown>,
    temperature: number,
  ): Promise<StructuredResult> {
    const info = MODELS[model];
    if (!info) throw new Error(`No price for model ${model}; add it to the Vertex adapter's price table`);
    const price = this.options.location === 'global' ? info.global : info.nonGlobal;
    const thinkingLevel = info.thinkingLevel ? thinkingLevelFor(task) : undefined;
    // Always one user turn and no penalties: Gemini 3.5 Flash-Lite rejects a request whose last turn is
    // the model's, and any custom frequency or presence penalty.
    const response = await this.transport(this.url(model), {
      systemInstruction: { parts: [{ text: prompt }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        ...(Object.keys(schema).length > 0 ? { responseJsonSchema: forVertex(schema) } : {}),
        temperature,
        ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
      },
    });
    const candidate = response.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text) throw new Error(`Vertex AI returned no output (finish reason ${candidate?.finishReason ?? 'none'})`);
    const output: unknown = JSON.parse(text);
    const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
    // Reasoning is billed as output, and Vertex reports it apart from the response tokens.
    const outputTokens = (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0);
    const costUsd = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
    return { output, inputTokens, outputTokens, costUsd };
  }
}
