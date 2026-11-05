import { describe, expect, it } from 'vitest';
import {
  type Fact,
  MODEL_TASK_NAMES,
  type ModelTaskInput,
  type ModelTaskName,
  modelTasks,
  type PlannedPost,
} from '../contracts/model-tasks.js';
import { describeModelProviderContract } from './contract-suites/model.js';
import { ModelSimulator, taskOutputJsonSchema } from './model.js';

const uuid = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

describeModelProviderContract('simulator', () => ({
  provider: new ModelSimulator(),
  model: 'simulator-model',
  imageUrl: 'https://storage.example.test/photo.jpg',
  audioUrl: 'https://storage.example.test/voice.ogg',
  audioLanguage: 'he',
}));

const fact: Fact = { id: 'f1', type: 'discount_percent', value: '20', sourceQuote: '20% הנחה על תמרים' };
const plan: PlannedPost = {
  topic: 'מבצע תמרים',
  contentType: 'promotions',
  format: 'single',
  factIds: ['f1'],
  mediaAssetIds: [uuid],
  brief: 'פוסט על 20% הנחה על תמרים',
};

const sampleInputs: { [T in ModelTaskName]: ModelTaskInput<T> } = {
  intent_detection: { text: 'יש לנו מבצע', step: 'idle', draftsOpen: false },
  transcription: { voiceAssetId: uuid, languageHint: 'he' },
  profile_extraction: { text: 'קוראים לנו פרחי דנה', draft: {}, askedFields: ['name', 'field'] },
  fact_extraction: { text: 'השבוע 20% הנחה על תמרים', profileSummary: 'חנות פירות יבשים' },
  weekly_planning: {
    facts: [fact],
    postsPerWeek: 4,
    contentTypes: ['promotions', 'tips'],
    formats: ['carousel'],
    mediaAssetIds: [uuid],
  },
  caption_writing: {
    plan,
    facts: [fact],
    businessContext: 'חנות פירות יבשים',
    preferenceRules: [],
    networks: ['instagram', 'facebook'],
    languages: ['he'],
    tone: { register: 'friendly', address: 'plural', emoji: true },
    fixedHashtags: ['#תמרים'],
  },
  change_interpretation: {
    text: 'תוריד את האימוג׳י',
    captions: { instagram: { text: 'מבצע!', hashtags: [] } },
    plan,
  },
  image_review: { mediaAssetId: uuid, purpose: 'post_photo' },
  fact_check: { caption: 'מבצע 20% על תמרים', facts: [fact] },
};

const request = (task: ModelTaskName, input: unknown = sampleInputs[task]) => ({
  task,
  model: 'simulator-model',
  prompt: `${task} v1`,
  input,
  outputJsonSchema: taskOutputJsonSchema(task),
  temperature: 0,
});

describe('ModelSimulator defaults', () => {
  it.each(MODEL_TASK_NAMES)('returns valid %s output for a sample input', async (task) => {
    const result = await new ModelSimulator().generateStructured(request(task));
    expect(modelTasks[task].output.safeParse(result.output).success).toBe(true);
  });

  it.each(MODEL_TASK_NAMES)('returns valid %s output when the input is not the task input', async (task) => {
    const result = await new ModelSimulator().generateStructured(request(task, { unexpected: true }));
    expect(modelTasks[task].output.safeParse(result.output).success).toBe(true);
  });

  it('passes the code checks: verbatim quotes, post count, allowed formats, requested networks', async () => {
    const sim = new ModelSimulator();
    const facts = modelTasks.fact_extraction.output.parse((await sim.generateStructured(request('fact_extraction'))).output);
    for (const f of facts.facts) expect(sampleInputs.fact_extraction.text).toContain(f.sourceQuote);

    const planned = modelTasks.weekly_planning.output.parse((await sim.generateStructured(request('weekly_planning'))).output);
    expect(planned.posts).toHaveLength(4);
    expect(planned.posts.every((p) => p.format === 'carousel')).toBe(true);

    const captions = modelTasks.caption_writing.output.parse((await sim.generateStructured(request('caption_writing'))).output);
    expect(Object.keys(captions.captions).sort()).toEqual(['facebook', 'instagram']);
  });
});

describe('ModelSimulator scripting', () => {
  it('identifies the task from the output JSON schema and records the call', async () => {
    const sim = new ModelSimulator();
    await sim.generateStructured(request('intent_detection'));
    expect(sim.calls).toHaveLength(1);
    expect(sim.callsFor('intent_detection')[0]).toMatchObject({
      method: 'generateStructured',
      task: 'intent_detection',
      request: { prompt: 'intent_detection v1', input: sampleInputs.intent_detection },
    });
  });

  it('returns scripted outputs once each, in order, then falls back to the default', async () => {
    const sim = new ModelSimulator();
    sim.script('intent_detection', { intent: 'weekly_update', confidence: 0.9 }, { intent: 'question', confidence: 0.7 });
    const outputs = [];
    for (let i = 0; i < 3; i++) outputs.push((await sim.generateStructured(request('intent_detection'))).output);
    expect(outputs.slice(0, 2)).toEqual([
      { intent: 'weekly_update', confidence: 0.9 },
      { intent: 'question', confidence: 0.7 },
    ]);
    expect(outputs[2]).toEqual(sim.defaultOutput('intent_detection', sampleInputs.intent_detection));
  });

  it('builds scripted outputs from the input', async () => {
    const sim = new ModelSimulator();
    sim.script('change_interpretation', (input) => ({ changes: [{ target: 'caption', instruction: input.text }] }));
    const { output } = await sim.generateStructured(request('change_interpretation'));
    expect(output).toEqual({ changes: [{ target: 'caption', instruction: 'תוריד את האימוג׳י' }] });
  });

  it('refuses to script a "valid" output that fails the task schema', () => {
    const sim = new ModelSimulator();
    expect(() => sim.script('intent_detection', { intent: 'approve', confidence: 1 } as never)).toThrow();
  });

  it('scripts invalid raw output for retry tests', async () => {
    const sim = new ModelSimulator();
    sim.scriptInvalid('weekly_planning', { posts: [] }, 'not json at all');
    const first = await sim.generateStructured(request('weekly_planning'));
    const second = await sim.generateStructured(request('weekly_planning'));
    const third = await sim.generateStructured(request('weekly_planning'));
    expect(modelTasks.weekly_planning.output.safeParse(first.output).success).toBe(false);
    expect(second.output).toBe('not json at all');
    expect(modelTasks.weekly_planning.output.safeParse(third.output).success).toBe(true);
  });

  it('scripts a provider failure', async () => {
    const sim = new ModelSimulator();
    sim.failNext('caption_writing', new Error('deadline exceeded'));
    await expect(sim.generateStructured(request('caption_writing'))).rejects.toThrow('deadline exceeded');
    expect(sim.callsFor('caption_writing')).toHaveLength(1);
  });

  it('serves image_review through analyzeImage', async () => {
    const sim = new ModelSimulator();
    sim.script('image_review', { usable: false, score: 0.2, issues: ['blurry'] });
    const result = await sim.analyzeImage({
      task: 'image_review',
      model: 'simulator-model',
      prompt: 'image_review v1',
      imageUrl: 'https://storage.example.test/photo.jpg',
      outputJsonSchema: taskOutputJsonSchema('image_review'),
    });
    expect(result.output).toEqual({ usable: false, score: 0.2, issues: ['blurry'] });
    expect(sim.callsFor('image_review')[0]?.method).toBe('analyzeImage');
  });

  it('throws when the output schema does not match the task', async () => {
    const sim = new ModelSimulator();
    await expect(sim.generateStructured({ ...request('fact_check'), outputJsonSchema: { type: 'string' } })).rejects.toThrow(
      /does not match task/i,
    );
  });

  it('throws for an unscripted call when defaults are off', async () => {
    const sim = new ModelSimulator({ defaults: false });
    await expect(sim.generateStructured(request('fact_check'))).rejects.toThrow(/no scripted output/i);
  });

  it('reports deterministic usage', async () => {
    const a = await new ModelSimulator().generateStructured(request('fact_check'));
    const b = await new ModelSimulator().generateStructured(request('fact_check'));
    expect(a).toEqual(b);
    expect(a.inputTokens).toBeGreaterThan(0);
    expect(a.costUsd).toBeGreaterThan(0);
  });

  it('transcribes by audio url, then by queue, then by default', async () => {
    const sim = new ModelSimulator();
    const req = (audioUrl: string) => ({ model: 'simulator-model', prompt: 'Transcribe.', audioUrl, languageHint: 'he' as const });
    sim.setTranscript('https://storage.example.test/a.ogg', { text: 'יש לנו צבעונים', language: 'he' });
    sim.scriptTranscription({ text: 'queued', language: 'ar' });
    expect(await sim.transcribeAudio(req('https://storage.example.test/a.ogg'))).toMatchObject({ text: 'יש לנו צבעונים' });
    expect(await sim.transcribeAudio(req('https://storage.example.test/b.ogg'))).toMatchObject({
      text: 'queued',
      language: 'ar',
    });
    expect((await sim.transcribeAudio(req('https://storage.example.test/b.ogg'))).language).toBe('he');
    expect(sim.calls.map((c) => c.method)).toEqual(['transcribeAudio', 'transcribeAudio', 'transcribeAudio']);
  });
});
