import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { modelTasks } from '../../../contracts/model-tasks.js';
import { describeModelProviderContract } from '../../../simulators/contract-suites/model.js';
import { adcTransport, realModelsRefused, type VertexRequestBody, type VertexTransport, VertexModelProvider } from './vertex.js';

const MODEL = 'gemini-2.5-flash';

/** A fake Vertex AI endpoint: answers by what the request asks for, records every call. */
function fakeTransport() {
  const calls: { url: string; body: VertexRequestBody }[] = [];
  const transport: VertexTransport = async (url, body) => {
    calls.push({ url, body });
    const parts = body.contents[0]?.parts ?? [];
    const inline = parts.find((p) => 'inlineData' in p);
    const schema = JSON.stringify(body.generationConfig.responseJsonSchema ?? {});
    let text: string;
    if (inline && 'inlineData' in inline && inline.inlineData.mimeType.startsWith('audio/')) {
      text = JSON.stringify({ text: 'יש לנו מבצע השבוע', language: 'he' });
    } else if (schema.includes('"score"')) {
      text = JSON.stringify({ usable: true, score: 0.8, issues: [] });
    } else {
      text = JSON.stringify({ intent: 'weekly_update', confidence: 0.9 });
    }
    return {
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 },
    };
  };
  return { transport, calls };
}

const fetchMedia = async (url: string) => ({
  mimeType: url.endsWith('.ogg') ? 'audio/ogg' : 'image/jpeg',
  data: Buffer.from('bytes'),
});

function provider(transport: VertexTransport) {
  return new VertexModelProvider({ project: 'postly-dev', location: 'global', transport, fetchMedia });
}

describeModelProviderContract('vertex adapter on a fake transport', () => ({
  provider: provider(fakeTransport().transport),
  model: MODEL,
  imageUrl: 'https://storage.example.test/photo.jpg',
  audioUrl: 'https://storage.example.test/voice.ogg',
  audioLanguage: 'he',
}));

describe('no paid model in tests or CI (agent.md, Testing)', () => {
  it('refuses the real transport under NODE_ENV=test or CI=true', () => {
    expect(realModelsRefused({ NODE_ENV: 'test' })).toBe(true);
    expect(realModelsRefused({ CI: 'true' })).toBe(true);
    expect(realModelsRefused({ NODE_ENV: 'production' })).toBe(false);
    expect(() => adcTransport({ CI: 'true' })).toThrow(/refused in tests and CI/);
    // This very test runs under Vitest: a provider without a fake transport cannot be built.
    expect(() => new VertexModelProvider({ project: 'p', location: 'global' })).toThrow(/refused in tests and CI/);
  });
});

describe('VertexModelProvider', () => {
  it('calls the Vertex generateContent endpoint of the project, with JSON output against the schema', async () => {
    const fake = fakeTransport();
    const outputJsonSchema = z.toJSONSchema(modelTasks.intent_detection.output);
    await provider(fake.transport).generateStructured({
      task: 'intent_detection',
      model: MODEL,
      prompt: 'Classify.',
      input: { text: 'שלום', step: 'idle', draftsOpen: false },
      outputJsonSchema,
      temperature: 0.3,
    });
    expect(fake.calls).toHaveLength(1);
    const { url, body } = fake.calls[0]!;
    expect(url).toBe(
      `https://aiplatform.googleapis.com/v1/projects/postly-dev/locations/global/publishers/google/models/${MODEL}:generateContent`,
    );
    expect(url).not.toMatch(/key=/);
    expect(body.systemInstruction.parts[0]).toEqual({ text: 'Classify.' });
    expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json', temperature: 0.3 });
    expect(body.generationConfig.responseJsonSchema).not.toHaveProperty('$schema');
  });

  it('uses the regional host for a regional location', async () => {
    const fake = fakeTransport();
    await new VertexModelProvider({ project: 'p', location: 'europe-west4', transport: fake.transport, fetchMedia }).generateStructured({
      task: 'intent_detection',
      model: MODEL,
      prompt: 'Classify.',
      input: {},
      outputJsonSchema: {},
      temperature: 0,
    });
    expect(fake.calls[0]!.url.startsWith('https://europe-west4-aiplatform.googleapis.com/v1/projects/p/locations/europe-west4/')).toBe(true);
  });

  it('computes the cost from the token counts', async () => {
    const result = await provider(fakeTransport().transport).generateStructured({
      task: 'intent_detection',
      model: MODEL,
      prompt: 'Classify.',
      input: {},
      outputJsonSchema: {},
      temperature: 0,
    });
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(200);
    // 1000 * 0.30/M + 200 * 2.50/M
    expect(result.costUsd).toBeCloseTo(0.0008, 8);
  });

  it('refuses a model without a price', async () => {
    const fake = fakeTransport();
    await expect(
      provider(fake.transport).generateStructured({
        task: 'intent_detection',
        model: 'gemini-unknown',
        prompt: 'Classify.',
        input: {},
        outputJsonSchema: {},
        temperature: 0,
      }),
    ).rejects.toThrow(/price/);
    expect(fake.calls).toHaveLength(0);
  });

  it('sends the photo as inline bytes', async () => {
    const fake = fakeTransport();
    await provider(fake.transport).analyzeImage({
      task: 'image_review',
      model: MODEL,
      prompt: 'Review.',
      imageUrl: 'https://storage.example.test/photo.jpg',
      outputJsonSchema: z.toJSONSchema(modelTasks.image_review.output),
    });
    expect(fake.calls[0]!.body.contents[0]!.parts).toContainEqual({
      inlineData: { mimeType: 'image/jpeg', data: Buffer.from('bytes').toString('base64') },
    });
  });

  it('transcribes with the prompt it is given, not one of its own', async () => {
    const fake = fakeTransport();
    await provider(fake.transport).transcribeAudio({
      model: MODEL,
      prompt: 'תמלל מילה במילה.',
      audioUrl: 'https://storage.example.test/voice.ogg',
      languageHint: 'he',
    });
    expect(fake.calls[0]!.body.systemInstruction.parts).toEqual([{ text: 'תמלל מילה במילה.' }]);
  });

  it('throws when the model returns no text', async () => {
    const transport: VertexTransport = async () => ({ candidates: [{ finishReason: 'SAFETY' }] });
    await expect(
      provider(transport).generateStructured({
        task: 'intent_detection',
        model: MODEL,
        prompt: 'Classify.',
        input: {},
        outputJsonSchema: {},
        temperature: 0,
      }),
    ).rejects.toThrow(/SAFETY/);
  });

  it('throws on output that is not JSON, so the model layer counts a failed attempt', async () => {
    const transport: VertexTransport = async () => ({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] });
    await expect(
      provider(transport).generateStructured({
        task: 'intent_detection',
        model: MODEL,
        prompt: 'Classify.',
        input: {},
        outputJsonSchema: {},
        temperature: 0,
      }),
    ).rejects.toThrow();
  });
});
