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
    temperature: number;
  };
}

export interface VertexResponseBody {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Posts one request to Vertex AI and returns the parsed response. Tests inject a fake. */
export type VertexTransport = (url: string, body: VertexRequestBody) => Promise<VertexResponseBody>;

/** Fetches a photo or voice note the adapter sends to the model as inline bytes. */
export type MediaFetcher = (url: string) => Promise<{ mimeType: string; data: Buffer }>;

/**
 * USD per million tokens (input, output), from the Vertex AI price list. PROVISIONAL: check before
 * launch; audio input is billed higher than text and is counted here at the text rate.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
};

export interface VertexOptions {
  project: string;
  /** `global`, or a region such as `europe-west4`. */
  location: string;
  transport?: VertexTransport;
  fetchMedia?: MediaFetcher;
}

/** Application Default Credentials: the Cloud Run service account in GCP, `gcloud auth application-default login` locally. */
export function adcTransport(): VertexTransport {
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
    return this.call(r.model, r.prompt, [{ text: JSON.stringify(r.input) }], r.outputJsonSchema, r.temperature);
  }

  async analyzeImage(request: AnalyzeImageRequest): Promise<StructuredResult> {
    const r = AnalyzeImageRequest.parse(request);
    const image = await this.inline(r.imageUrl);
    return this.call(r.model, r.prompt, [image], r.outputJsonSchema, 0);
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
    const result = await this.call(r.model, r.prompt, [input, audio], schema, 0);
    const output = result.output as { text: string; language: string };
    return { text: output.text, language: Language.parse(output.language), costUsd: result.costUsd };
  }

  private async inline(url: string): Promise<Part> {
    const media = await this.fetchMedia(url);
    return { inlineData: { mimeType: media.mimeType, data: media.data.toString('base64') } };
  }

  private url(model: string): string {
    const { project, location } = this.options;
    const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
    return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
  }

  private async call(
    model: string,
    prompt: string,
    parts: Part[],
    schema: Record<string, unknown>,
    temperature: number,
  ): Promise<StructuredResult> {
    const price = PRICES[model];
    if (!price) throw new Error(`No price for model ${model}; add it to the Vertex adapter's price table`);
    const response = await this.transport(this.url(model), {
      systemInstruction: { parts: [{ text: prompt }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        ...(Object.keys(schema).length > 0 ? { responseJsonSchema: forVertex(schema) } : {}),
        temperature,
      },
    });
    const candidate = response.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text) throw new Error(`Vertex AI returned no output (finish reason ${candidate?.finishReason ?? 'none'})`);
    const output: unknown = JSON.parse(text);
    const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    const costUsd = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
    return { output, inputTokens, outputTokens, costUsd };
  }
}
