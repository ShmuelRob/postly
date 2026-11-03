import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { MODEL_TASK_NAMES } from '../../contracts/model-tasks.js';
import { createDatabase } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { ModelSimulator } from '../../simulators/model.js';
import { createModelLayer, ModelTaskFailedError } from './index.js';

// The model layer against the migrated database and the model simulator: seed rows, model_run per
// attempt, retries within model_task_config.max_retries, and console routing (technical-design.md).

const db = createDatabase(inject('databaseUrls'), { max: 4 });
afterAll(() => db.close());

const intent = { text: 'יש לנו מבצע השבוע', step: 'idle', draftsOpen: false } as const;
const validIntent = { intent: 'weekly_update', confidence: 0.9 } as const;

async function newBusiness(): Promise<string> {
  const id = randomUUID();
  await db.withBusiness('workflow', id, (tx) =>
    tx.insert(schema.business).values({ id, name: `b-${id}`, approverPhone: `+9725${Math.floor(1e7 + Math.random() * 9e7)}` }),
  );
  return id;
}

const runsOf = (businessId: string) =>
  db.withBusiness('model', businessId, (tx) => tx.select().from(schema.modelRun).orderBy(schema.modelRun.attempt));
const consoleOf = (businessId: string) => db.withBusiness('model', businessId, (tx) => tx.select().from(schema.consoleItem));

let sim: ModelSimulator;
let businessId: string;
beforeEach(async () => {
  sim = new ModelSimulator({ defaults: false });
  businessId = await newBusiness();
});

describe('seed rows', () => {
  it('has a config row and its active prompt version for every task', async () => {
    const rows = await db.withBusiness('model', businessId, async (tx) => ({
      configs: await tx.select().from(schema.modelTaskConfig),
      prompts: await tx.select().from(schema.promptTemplate),
    }));
    expect(rows.configs.map((c) => c.task).sort()).toEqual([...MODEL_TASK_NAMES].sort());
    for (const config of rows.configs) {
      expect(config.maxRetries).toBe(2);
      expect(rows.prompts.some((p) => p.task === config.task && p.version === config.activePromptVersion)).toBe(true);
    }
  });
});

describe('model layer run', () => {
  const layer = () => createModelLayer({ db, providers: { google: sim } });

  it('returns valid output and records one model_run with prompt version, cost and duration', async () => {
    sim.script('intent_detection', validIntent);
    await expect(layer().run(businessId, 'intent_detection', intent)).resolves.toEqual(validIntent);

    const [call] = sim.callsFor('intent_detection');
    expect(call?.request).toMatchObject({ task: 'intent_detection', model: 'gemini-2.5-flash', temperature: 0, input: intent });
    expect((call?.request as { prompt: string }).prompt).toContain('אין כוונה של אישור');

    const runs = await runsOf(businessId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ task: 'intent_detection', promptVersion: 1, provider: 'google', attempt: 1, valid: true, error: null });
    expect(runs[0]?.input).toEqual(intent);
    expect(runs[0]?.output).toEqual(validIntent);
    expect(Number(runs[0]?.costUsd)).toBeGreaterThan(0);
    expect(runs[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(await consoleOf(businessId)).toHaveLength(0);
  });

  it('retries invalid output and returns the first valid one', async () => {
    sim.scriptInvalid('intent_detection', { intent: 'approve', confidence: 1 }, 'not json');
    sim.script('intent_detection', validIntent);
    await expect(layer().run(businessId, 'intent_detection', intent)).resolves.toEqual(validIntent);

    const runs = await runsOf(businessId);
    expect(runs.map((r) => [r.attempt, r.valid])).toEqual([[1, false], [2, false], [3, true]]);
    expect(runs[0]?.output).toEqual({ intent: 'approve', confidence: 1 });
    expect(runs[0]?.error).toMatch(/intent/);
    expect(await consoleOf(businessId)).toHaveLength(0);
  });

  it('after max_retries routes the task to console_item and throws', async () => {
    sim.scriptInvalid('intent_detection', { intent: 'approve' }, { intent: 'approve' }, { intent: 'approve' });
    const referenceId = randomUUID();
    const error = await layer()
      .run(businessId, 'intent_detection', intent, { referenceId })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelTaskFailedError);
    expect(sim.callsFor('intent_detection')).toHaveLength(3);

    const runs = await runsOf(businessId);
    expect(runs.map((r) => r.valid)).toEqual([false, false, false]);
    const [item] = await consoleOf(businessId);
    expect(item).toMatchObject({ kind: 'model_validation_failed', status: 'open', referenceId, id: (error as ModelTaskFailedError).consoleItemId });
    expect(item?.details).toMatchObject({ task: 'intent_detection', promptVersion: 1, attempts: 3, modelRunIds: runs.map((r) => r.id) });
  });

  it('counts a provider failure as an attempt', async () => {
    sim.failNext('intent_detection', new Error('quota'));
    sim.script('intent_detection', validIntent);
    await layer().run(businessId, 'intent_detection', intent);
    const runs = await runsOf(businessId);
    expect(runs.map((r) => [r.valid, r.error, r.output])).toEqual([
      [false, 'provider error: quota', null],
      [true, null, validIntent],
    ]);
  });

  it('rejects input outside the task schema without calling the model', async () => {
    await expect(layer().run(businessId, 'intent_detection', { ...intent, text: '' })).rejects.toThrow();
    expect(sim.calls).toHaveLength(0);
  });

  it('keeps model_run and console_item inside the calling business', async () => {
    sim.scriptInvalid('intent_detection', 1, 2, 3);
    await layer().run(businessId, 'intent_detection', intent).catch(() => undefined);
    const other = await newBusiness();
    expect(await runsOf(other)).toHaveLength(0);
    expect(await consoleOf(other)).toHaveLength(0);
    expect((await runsOf(businessId)).every((r) => r.businessId === businessId)).toBe(true);
  });

  it('serves transcription and image_review through media urls', async () => {
    const urls: string[] = [];
    const media = createModelLayer({
      db,
      providers: { google: sim },
      resolveMediaUrl: async (b, id) => {
        urls.push(`${b}/${id}`);
        return `https://storage.example.test/${id}`;
      },
    });
    const asset = randomUUID();
    sim.scriptTranscription({ text: 'שלום', language: 'he' });
    await expect(media.run(businessId, 'transcription', { voiceAssetId: asset, languageHint: 'he' })).resolves.toEqual({ text: 'שלום', language: 'he' });
    sim.script('image_review', { usable: true, score: 0.8, issues: [] });
    await media.run(businessId, 'image_review', { mediaAssetId: asset, purpose: 'logo' });
    expect(urls).toEqual([`${businessId}/${asset}`, `${businessId}/${asset}`]);
    expect(sim.callsFor('image_review')[0]?.request).toMatchObject({ task: 'image_review', imageUrl: `https://storage.example.test/${asset}` });
  });
});

describe('config limits', () => {
  // Changes a shared seed row through the system role and restores it after each test.
  const original = { fallbackProvider: null, fallbackModel: null, maxCostUsd: '0.010000' };
  const setConfig = (values: Partial<typeof schema.modelTaskConfig.$inferInsert>) =>
    db.withSystem('console', (tx) => tx.update(schema.modelTaskConfig).set(values).where(eq(schema.modelTaskConfig.task, 'intent_detection')));
  afterEach(() => setConfig(original));

  it('moves to the fallback provider after a provider failure', async () => {
    await setConfig({ fallbackProvider: 'backup', fallbackModel: 'backup-model' });
    const backup = new ModelSimulator({ defaults: false });
    sim.failNext('intent_detection');
    backup.script('intent_detection', validIntent);
    await createModelLayer({ db, providers: { google: sim, backup } }).run(businessId, 'intent_detection', intent);
    const runs = await runsOf(businessId);
    expect(runs.map((r) => [r.provider, r.model, r.valid])).toEqual([
      ['google', 'gemini-2.5-flash', false],
      ['backup', 'backup-model', true],
    ]);
  });

  it('stops retrying once max_cost_usd is spent', async () => {
    await setConfig({ maxCostUsd: '0.000001' });
    sim.scriptInvalid('intent_detection', { intent: 'approve' }, { intent: 'approve' });
    await expect(createModelLayer({ db, providers: { google: sim } }).run(businessId, 'intent_detection', intent)).rejects.toThrow(
      ModelTaskFailedError,
    );
    expect(sim.callsFor('intent_detection')).toHaveLength(1);
    const [item] = await consoleOf(businessId);
    expect((item?.details as { errors: string[] }).errors.at(-1)).toMatch(/cost limit/);
  });
});
