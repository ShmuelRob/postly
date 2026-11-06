import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { modelTasks } from '../../../contracts/model-tasks.js';
import { describeModelProviderContract } from '../../../simulators/contract-suites/model.js';
import { adcTransport, realModelsRefused, type VertexRequestBody, type VertexTransport, VertexModelProvider } from './vertex.js';

const MODEL = 'gemini-3.5-flash-lite';

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

  it('uses the multi-region host for eu and us (Gemini 3.5 Flash-Lite is not served from single regions)', async () => {
    for (const location of ['eu', 'us']) {
      const fake = fakeTransport();
      await new VertexModelProvider({ project: 'p', location, transport: fake.transport, fetchMedia }).generateStructured({
        task: 'intent_detection',
        model: MODEL,
        prompt: 'Classify.',
        input: {},
        outputJsonSchema: {},
        temperature: 0,
      });
      expect(fake.calls[0]!.url).toBe(
        `https://aiplatform.${location}.rep.googleapis.com/v1/projects/p/locations/${location}/publishers/google/models/${MODEL}:generateContent`,
      );
    }
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

  it('charges the non-global price off the global endpoint (Vertex pricing, Gemini 3 and later)', async () => {
    const result = await new VertexModelProvider({ project: 'p', location: 'eu', transport: fakeTransport().transport, fetchMedia }).generateStructured({
      task: 'intent_detection',
      model: MODEL,
      prompt: 'Classify.',
      input: {},
      outputJsonSchema: {},
      temperature: 0,
    });
    // 1000 * 0.33/M + 200 * 2.75/M
    expect(result.costUsd).toBeCloseTo(0.00088, 8);
  });

  it('counts thinking tokens as output tokens: Vertex bills reasoning at the output price', async () => {
    const transport: VertexTransport = async () => ({
      candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 300 },
    });
    const result = await provider(transport).generateStructured({
      task: 'agent_onboarding',
      model: MODEL,
      prompt: 'Act.',
      input: {},
      outputJsonSchema: {},
      temperature: 0.2,
    });
    expect(result.outputTokens).toBe(500);
    // 1000 * 0.30/M + 500 * 2.50/M
    expect(result.costUsd).toBeCloseTo(0.00155, 8);
  });

  it('refuses the retired Gemini 2.5 models (Vertex retired them on 2026-10-20)', async () => {
    const fake = fakeTransport();
    for (const model of ['gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
      await expect(
        provider(fake.transport).generateStructured({ task: 'intent_detection', model, prompt: 'Classify.', input: {}, outputJsonSchema: {}, temperature: 0 }),
      ).rejects.toThrow(/price/);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('asks the agent tasks to think at MEDIUM, and leaves the one-shot tasks on the default', async () => {
    const fake = fakeTransport();
    for (const task of ['agent_onboarding', 'agent_weekly', 'agent_drafts', 'intent_detection'] as const) {
      await provider(fake.transport).generateStructured({ task, model: MODEL, prompt: 'Act.', input: {}, outputJsonSchema: {}, temperature: 0.2 });
    }
    await provider(fake.transport).analyzeImage({ task: 'image_review', model: MODEL, prompt: 'Review.', imageUrl: 'https://storage.example.test/photo.jpg', outputJsonSchema: {} });
    const thinking = fake.calls.map((c) => c.body.generationConfig.thinkingConfig);
    expect(thinking).toEqual([{ thinkingLevel: 'MEDIUM' }, { thinkingLevel: 'MEDIUM' }, { thinkingLevel: 'MEDIUM' }, undefined, undefined]);
  });

  // Gemini 3.5 Flash-Lite rejects a request whose last contents turn has the role `model`, and any custom
  // frequency or presence penalty (agent.md, Running on dev). The agent's history travels inside its input.
  it('sends every request as one user turn, with no frequency or presence penalty', async () => {
    const fake = fakeTransport();
    const p = provider(fake.transport);
    await p.generateStructured({
      task: 'agent_drafts',
      model: MODEL,
      prompt: 'Act.',
      input: { history: [{ role: 'model', text: 'previous step' }] },
      outputJsonSchema: {},
      temperature: 0.2,
    });
    await p.analyzeImage({ task: 'image_review', model: MODEL, prompt: 'Review.', imageUrl: 'https://storage.example.test/photo.jpg', outputJsonSchema: {} });
    await p.transcribeAudio({ model: MODEL, prompt: 'Transcribe.', audioUrl: 'https://storage.example.test/voice.ogg', languageHint: 'he' });
    expect(fake.calls).toHaveLength(3);
    for (const { body } of fake.calls) {
      expect(body.contents.map((c) => c.role)).toEqual(['user']);
      expect(body.contents.at(-1)!.role).not.toBe('model');
      expect(Object.keys(body.generationConfig)).not.toContain('frequencyPenalty');
      expect(Object.keys(body.generationConfig)).not.toContain('presencePenalty');
    }
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
