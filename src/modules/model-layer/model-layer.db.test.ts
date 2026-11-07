import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { MODEL_TASK_NAMES } from '../../contracts/model-tasks.js';
import { createDatabase } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import type { ModelProvider } from '../../contracts/providers/model.js';
import { ModelSimulator } from '../../simulators/model.js';
import { createModelLayer, ModelTaskFailedError } from './index.js';
import { memoryTelemetry } from '../../shared/telemetry-memory.js';
import { setLogSink } from '../../shared/logger.js';

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
  it('runs every task on Gemini 3.5 Flash-Lite through Google, with no fallback (0023)', async () => {
    const rows = await db.withBusiness('model', businessId, (tx) => tx.select().from(schema.modelTaskConfig));
    expect(rows).toHaveLength(MODEL_TASK_NAMES.length);
    for (const row of rows) {
      expect([row.task, row.provider, row.model]).toEqual([row.task, 'google', 'gemini-3.5-flash-lite']);
      expect(row.fallbackModel).toBeNull();
    }
  });

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
    expect(call?.request).toMatchObject({ task: 'intent_detection', model: 'gemini-3.5-flash-lite', temperature: 0, input: intent });
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

  // docs/observability.md, Timing lines: one `model call` line per attempt, with no input or output.
  it('logs each attempt with its task, model, duration, attempt, outcome and token counts, and nothing of the input', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      sim.scriptInvalid('intent_detection', { intent: 'approve' });
      sim.script('intent_detection', validIntent);
      await layer().run(businessId, 'intent_detection', intent);
    } finally {
      setLogSink(undefined);
    }
    const calls = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.message === 'model call');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ task: 'intent_detection', provider: 'google', model: 'gemini-3.5-flash-lite', attempt: 1, outcome: 'invalid' });
    expect(calls[1]).toMatchObject({ attempt: 2, outcome: 'valid' });
    // docs/observability.md, "Following one message": the prompt version, and the Zod issue paths only.
    expect(calls[0]).toMatchObject({ severity: 'WARNING', promptVersion: 1, invalidPaths: 'confidence' });
    expect(calls[1]).toMatchObject({ severity: 'INFO', promptVersion: 1 });
    expect(calls[1]).not.toHaveProperty('invalidPaths');
    for (const call of calls) {
      expect(call.durationMs).toEqual(expect.any(Number));
      expect(call.inputTokens).toEqual(expect.any(Number));
      expect(call.outputTokens).toEqual(expect.any(Number));
    }
    expect(lines.join('\n')).not.toContain(intent.text);
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

  it('counts a failed code check as a failed attempt and retries (RunOptions.check)', async () => {
    const low = { intent: 'weekly_update', confidence: 0.1 } as const;
    sim.script('intent_detection', low, validIntent);
    const check = (output: { confidence: number }) => (output.confidence < 0.5 ? 'confidence too low' : null);
    await expect(layer().run(businessId, 'intent_detection', intent, { check })).resolves.toEqual(validIntent);

    const runs = await runsOf(businessId);
    expect(runs.map((r) => [r.valid, r.error])).toEqual([
      [false, 'code check: confidence too low'],
      [true, null],
    ]);
  });

  it('routes to the console when the code check fails every attempt', async () => {
    sim.script('intent_detection', validIntent, validIntent, validIntent);
    const error = await layer()
      .run(businessId, 'intent_detection', intent, { check: () => 'never passes' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelTaskFailedError);
    expect((error as ModelTaskFailedError).reason).toBe('code check: never passes');
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
    const transcribe = sim.calls.find((c) => c.method === 'transcribeAudio');
    expect(transcribe?.request.prompt).toMatch(/^תמלל את ההודעה הקולית/);
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
      ['google', 'gemini-3.5-flash-lite', false],
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

// agent.md, Limits (WP-90): a step's cap counts every attempt, retries included; spend for the budgets.
describe('agent budgets', () => {
  const setCap = (maxCostUsd: string) =>
    db.withSystem('console', (tx) => tx.update(schema.modelTaskConfig).set({ maxCostUsd }).where(eq(schema.modelTaskConfig.task, 'intent_detection')));
  afterEach(() => setCap('0.010000'));

  /** A provider whose every answer is invalid and costs `costUsd`. */
  const pricey = (costUsd: number): ModelProvider => ({
    name: 'google',
    generateStructured: async () => ({ output: { intent: 'approve' }, inputTokens: 1, outputTokens: 1, costUsd }),
    analyzeImage: async () => ({ output: {}, inputTokens: 1, outputTokens: 1, costUsd }),
    transcribeAudio: async () => ({ text: '', language: 'he', costUsd }),
  });

  it('starts a retry only while the spend so far plus the last attempt stays within the cap', async () => {
    await setCap('1.000000');
    const layer = createModelLayer({ db, providers: { google: pricey(0.008) } });
    await expect(layer.run(businessId, 'intent_detection', intent, { maxCostUsd: 0.02 })).rejects.toThrow(ModelTaskFailedError);
    const runs = await runsOf(businessId);
    expect(runs).toHaveLength(2);
    expect(runs.reduce((sum, r) => sum + Number(r.costUsd), 0)).toBeLessThanOrEqual(0.02);
    const [item] = await consoleOf(businessId);
    expect((item?.details as { errors: string[] }).errors.at(-1)).toMatch(/cost limit/);
  });

  it('uses the lower of the config cap and the caller cap', async () => {
    await setCap('0.010000');
    const layer = createModelLayer({ db, providers: { google: pricey(0.008) } });
    await expect(layer.run(businessId, 'intent_detection', intent, { maxCostUsd: 0.5 })).rejects.toThrow(ModelTaskFailedError);
    expect(await runsOf(businessId)).toHaveLength(1);
  });

  it('records the agent turn on every model_run of the call', async () => {
    const agentTurnId = randomUUID();
    sim.scriptInvalid('intent_detection', { intent: 'approve' });
    sim.script('intent_detection', validIntent);
    await createModelLayer({ db, providers: { google: sim } }).run(businessId, 'intent_detection', intent, { agentTurnId });
    expect((await runsOf(businessId)).map((r) => r.agentTurnId)).toEqual([agentTurnId, agentTurnId]);
  });

  it('sums a business spend, and every business spend, since a time', async () => {
    const other = await newBusiness();
    const layer = createModelLayer({ db, providers: { google: pricey(0.004) } });
    const since = new Date(Date.now() - 1000);
    await setCap('0.004000');
    await layer.run(businessId, 'intent_detection', intent).catch(() => undefined);
    await layer.run(other, 'intent_detection', intent).catch(() => undefined);
    expect(await layer.spentSince(businessId, since)).toBeCloseTo(0.004, 6);
    expect(await layer.spentSince(businessId, new Date(Date.now() + 60_000))).toBe(0);
    expect(await layer.spentByAllSince(since)).toBeGreaterThanOrEqual(0.008 - 1e-9);
  });
});

// docs/observability.md, Metrics (WP-48): one call count, latency and cost per attempt, by task.
describe('model metrics', () => {
  it('records every attempt by task and outcome, with its cost, and no input text in any label', async () => {
    const telemetry = memoryTelemetry();
    try {
      sim.failNext('intent_detection', new Error('quota'));
      sim.scriptInvalid('intent_detection', { intent: 'approve' });
      sim.script('intent_detection', validIntent);
      await createModelLayer({ db, providers: { google: sim } }).run(businessId, 'intent_detection', intent);

      const calls = await telemetry.points('postly.model.calls.count');
      expect(calls).toEqual(
        expect.arrayContaining([
          { labels: { task: 'intent_detection', outcome: 'provider_error' }, value: 1 },
          { labels: { task: 'intent_detection', outcome: 'invalid' }, value: 1 },
          { labels: { task: 'intent_detection', outcome: 'valid' }, value: 1 },
        ]),
      );
      const latency = await telemetry.points('postly.model.latency');
      expect(latency.reduce((n, p) => n + (p.count ?? 0), 0)).toBe(3);
      const [cost] = await telemetry.points('postly.model.cost_usd');
      expect(cost!.labels).toEqual({ task: 'intent_detection' });
      expect(cost!.value).toBeGreaterThan(0);
      expect(telemetry.spans().filter((s) => s.name === 'model intent_detection')).toHaveLength(3);
      expect(JSON.stringify(await telemetry.allPoints()) + JSON.stringify(telemetry.spans())).not.toContain(intent.text);
    } finally {
      telemetry.stop();
    }
  });
});
