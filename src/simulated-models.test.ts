import { describe, expect, it } from 'vitest';
import type { VertexRequestBody, VertexResponseBody } from './modules/model-layer/index.js';
import { simulatedModels } from './simulated.js';

// The deployed composition's model choice (agent.md, Running on dev): POSTLY_MODELS=vertex puts the
// model layer on the Vertex AI adapter, with WhatsApp, publishing and payments still simulated. Every
// test here injects a fake transport; no test builds the real one, and without one the adapter refuses
// to start under NODE_ENV=test.

const media = {
  async read(ref: string) {
    return ref === 'https://web.dev.test/media/inbound/logo.png' ? { mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) } : undefined;
  },
};

function fakeTransport(output: unknown) {
  const calls: { url: string; body: VertexRequestBody }[] = [];
  const transport = async (url: string, body: VertexRequestBody): Promise<VertexResponseBody> => {
    calls.push({ url, body });
    return { candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 } };
  };
  return { calls, transport };
}

describe('the deployed composition chooses the model provider', () => {
  it('uses the model simulator when no Vertex settings are given', () => {
    const models = simulatedModels({}, media);
    expect(Object.keys(models)).toEqual(['google']);
    expect(models.google!.constructor.name).not.toBe('VertexModelProvider');
  });

  it('uses Vertex AI as the google provider, at the configured project and location', async () => {
    const { calls, transport } = fakeTransport({ ok: true });
    const models = simulatedModels({ vertex: { project: 'postly-dev-test', location: 'eu', transport } }, media);
    expect(models.google!.constructor.name).toBe('VertexModelProvider');
    const result = await models.google!.generateStructured({
      task: 'agent_onboarding',
      model: 'gemini-3.5-flash-lite',
      prompt: 'the versioned prompt',
      input: { hello: 'שלום' },
      outputJsonSchema: { type: 'object' },
      temperature: 0.2,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://aiplatform.eu.rep.googleapis.com/v1/projects/postly-dev-test/locations/eu/publishers/google/models/gemini-3.5-flash-lite:generateContent',
    );
    expect(result.output).toEqual({ ok: true });
    // 3.5 Flash-Lite's non-global price (eu): 1000 input and 100 output tokens.
    expect(result.costUsd).toBeCloseTo((1000 * 0.33 + 100 * 2.75) / 1_000_000, 12);
  });

  it('reads the photos the model sees from the simulator store, not over HTTP', async () => {
    const { calls, transport } = fakeTransport({ description: 'logo' });
    const models = simulatedModels({ vertex: { project: 'postly-dev-test', location: 'eu', transport } }, media);
    await models.google!.analyzeImage({
      task: 'image_review',
      model: 'gemini-3.5-flash-lite',
      prompt: 'review the photo',
      imageUrl: 'https://web.dev.test/media/inbound/logo.png',
      outputJsonSchema: { type: 'object' },
    });
    expect(calls[0]!.body.contents[0]!.parts).toEqual([{ inlineData: { mimeType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') } }]);
    await expect(
      models.google!.analyzeImage({ task: 'image_review', model: 'gemini-3.5-flash-lite', prompt: 'p', imageUrl: 'https://web.dev.test/media/missing.png', outputJsonSchema: {} }),
    ).rejects.toThrow('no stored file');
  });

  it('never builds the real transport in a test: without an injected one it refuses to start', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(() => simulatedModels({ vertex: { project: 'postly-dev-test', location: 'eu' } }, media)).toThrow('refused in tests and CI');
  });
});
