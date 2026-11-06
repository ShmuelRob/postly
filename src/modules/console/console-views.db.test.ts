import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { z } from 'zod';
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { roleWith } from '../../../test/db/grant-matrix.js';
import { inserter, seed, type Seeded } from '../../../test/db/rows.js';
import { BUSINESS_ROLES, createDatabase, onlyLogins, PROCESS_LOGINS, type BusinessRole, type Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createWorkflow } from '../workflow/index.js';
import { ConsoleActionError, createConsole, registerConsoleRoutes } from './index.js';

// The redesigned console's read models and writes (technical-design.md, "Console (Phase 1)";
// database-schema.md, `console_action`; security.md, "What the console may change"). Written from the
// docs and the shared contract before the implementation.

const db = createDatabase(inject('databaseUrls'), { max: 4 });
// Only the console process's logins (D9): a read or write that needs another login fails here.
const consoleDb = createDatabase(onlyLogins(inject('databaseUrls'), PROCESS_LOGINS.console), { max: 2 });
const workflow = createWorkflow(consoleDb, { rejected: () => {} });
const c = createConsole(consoleDb, workflow);
const ACTOR = 'team@postly';
afterAll(async () => {
  await consoleDb.close();
  await db.close();
});

const sys = <T>(fn: (tx: Tx) => Promise<T>) => db.withSystem('console', fn);
const as = <T>(table: string, businessId: string, fn: (tx: Tx) => Promise<T>) => db.withBusiness(inserter(table), businessId, fn);
const approvalUpdater = roleWith('approval', 'UPDATE', BUSINESS_ROLES) as BusinessRole;

/** The status and reason of a refused call: a ConsoleActionError, or a ZodError (400, routes.ts). */
async function refusal(run: Promise<unknown>): Promise<{ status: number; reason?: string }> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (error instanceof ConsoleActionError) return { status: error.status, reason: error.reason };
  if (error instanceof z.ZodError) return { status: 400 };
  throw new Error(`expected a refusal, got ${error === undefined ? 'success' : String(error)}`);
}

const businessRow = async (id: string) => (await sys((tx) => tx.select().from(schema.business).where(eq(schema.business.id, id))))[0]!;
const actionsOf = (target: string) =>
  sys((tx) => tx.select().from(schema.consoleAction).where(eq(schema.consoleAction.target, target)).orderBy(desc(schema.consoleAction.createdAt)));

/** The approval and publication rows of every business: the console never changes them. */
const approvalState = () =>
  sys(async (tx) => ({
    approvals: await tx.select().from(schema.approval).orderBy(schema.approval.id),
    publications: await tx.select().from(schema.publication).orderBy(schema.publication.id),
  }));

/** A full BusinessProfile (contracts.md) for a business whose approver is `approverPhone`. */
const fullProfile = (approverPhone: string, name = 'מאפיית השכונה') => ({
  name,
  field: 'מאפייה',
  mainProducts: ['חלות', 'עוגות שמרים'],
  location: { city: 'חולון', address: 'רחוב הרצל 12', hours: 'א׳-ה׳ 7:00-19:00', fulfillment: ['pickup'] },
  differentiator: 'בצק שתופח 24 שעות',
  channels: ['instagram', 'facebook'],
  style: 'warm',
  approverPhone,
});

const activate = (id: string) => sys((tx) => tx.update(schema.business).set({ status: 'active' }).where(eq(schema.business.id, id)));

describe('overview', () => {
  it('counts the 24-hour windows and zero-fills 14 days of cost before a fixed now', async () => {
    const s = await seed(db);
    // A random day far in the future, so no other test's rows fall in its windows, and this test's
    // failures and turns are the newest anywhere.
    const day = new Date(Date.UTC(2090 + Math.floor(Math.random() * 9), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 27), 12));
    const now = new Date(day.getTime() + 60_000);
    const ago = (ms: number) => new Date(day.getTime() - ms);
    const H = 3_600_000;
    const run = (createdAt: Date, costUsd: string, valid: boolean, error: string | null = null) => ({
      id: randomUUID(),
      businessId: s.id,
      task: 'fact_extraction' as const,
      promptVersion: 1,
      provider: 'sim',
      model: 'm',
      input: {},
      valid,
      error,
      costUsd,
      createdAt,
    });
    const runs = [run(ago(H), '0.5', true), run(ago(2 * H), '0.25', false, 'schema'), run(ago(3 * 24 * H), '1', true), run(ago(20 * 24 * H), '7', true)];
    await as('model_run', s.id, (tx) => tx.insert(schema.modelRun).values(runs));
    const turn = (startedAt: Date, status: 'done' | 'failed' | 'handed_off', costUsd: string) => ({
      id: randomUUID(),
      businessId: s.id,
      agent: 'weekly' as const,
      status,
      trigger: { kind: 'event', name: 'test' },
      costUsd,
      startedAt,
    });
    const turns = [turn(ago(H), 'done', '0.1'), turn(ago(5 * H), 'failed', '0.2'), turn(ago(6 * H), 'handed_off', '0.3'), turn(ago(30 * H), 'done', '9')];
    await as('agent_turn', s.id, (tx) => tx.insert(schema.agentTurn).values(turns));
    // The seeded publication was published a day before now.
    await sys((tx) =>
      tx.update(schema.publication).set({ status: 'published', publishedAt: ago(24 * H - 1) }).where(eq(schema.publication.id, s.keys.get('publication')!)),
    );

    const o = await c.overview(now);

    expect(o.modelRuns24h.count).toBe(2);
    expect(o.modelRuns24h.failed).toBe(1);
    expect(o.modelRuns24h.costUsd).toBeCloseTo(0.75, 6);
    expect(o.agentTurns24h).toMatchObject({ count: 3, failed: 1, handedOff: 1 });
    expect(o.agentTurns24h.costUsd).toBeCloseTo(0.6, 6);

    expect(o.costByDay).toHaveLength(14);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    expect(o.costByDay.at(-1)!.day).toBe(iso(day));
    expect(o.costByDay[0]!.day).toBe(iso(new Date(day.getTime() - 13 * 24 * H)));
    const byDay = Object.fromEntries(o.costByDay.map((d) => [d.day, d.usd]));
    expect(byDay[iso(day)]).toBeCloseTo(0.75, 6);
    expect(byDay[iso(ago(3 * 24 * H))]).toBeCloseTo(1, 6);
    expect(o.costByDay.filter((d) => d.usd === 0)).toHaveLength(12);
    expect(o.costByDay.map((d) => d.day)).toEqual([...o.costByDay.map((d) => d.day)].sort());

    expect(o.publications.published7d).toBe(1);
    expect(o.publications.scheduled).toBeGreaterThanOrEqual(0);
    expect(o.publications.failed).toBeGreaterThanOrEqual(0);
    expect(o.businesses.onboarding).toBeGreaterThanOrEqual(1);
    expect(o.openItems.handoff).toBeGreaterThanOrEqual(1);

    // The newest failures and turns: this test's are the newest in the database.
    expect(o.recentFailures.length).toBeLessThanOrEqual(10);
    expect(o.recentFailures[0]).toMatchObject({ kind: 'model_run', id: runs[1]!.id, businessId: s.id, label: 'fact_extraction', error: 'schema' });
    expect(o.recentTurns.length).toBeLessThanOrEqual(10);
    expect(o.recentTurns.slice(0, 4).map((t) => t.id)).toEqual(turns.map((t) => t.id));
    expect(o.recentTurns[0]).toMatchObject({ businessId: s.id, agent: 'weekly', status: 'done', stepCount: 0 });
    expect(o.recentTurns[0]).not.toHaveProperty('steps');
  });
});

describe('business rows and detail', () => {
  it('lists each business with its newest message and its open item count', async () => {
    const s = await seed(db);
    await as('message', s.id, (tx) =>
      tx.insert(schema.message).values({
        businessId: s.id,
        direction: 'outbound',
        kind: 'text',
        provider: 'sim',
        providerMessageId: `out-${randomUUID()}`,
        fromPhone: '+972501234561',
        toPhone: '+972501234560',
        body: 'שלום! איך אפשר לעזור?',
        createdAt: new Date(Date.now() + 1000),
      }),
    );
    await sys((tx) => tx.insert(schema.consoleItem).values({ businessId: s.id, kind: 'draft_failed' }));
    const rows = await c.businessRows();
    const mine = rows.find((r) => r.id === s.id)!;
    expect(mine).toMatchObject({
      status: 'onboarding',
      handoffAt: null,
      openItems: 2,
      lastMessage: { body: 'שלום! איך אפשר לעזור?', kind: 'text', direction: 'outbound', createdAt: expect.any(Date) },
    });
    const created = rows.map((r) => r.createdAt.getTime());
    expect(created).toEqual([...created].sort((a, b) => b - a));
  });

  it('returns one business with its profile, channels, subscription and cost; 404 when missing', async () => {
    const s = await seed(db);
    await as('model_run', s.id, (tx) =>
      tx.insert(schema.modelRun).values({ businessId: s.id, task: 'fact_extraction', promptVersion: 1, provider: 'sim', model: 'm', input: {}, valid: true, costUsd: '0.125' }),
    );
    const b = await c.business(s.id);
    expect(b).toMatchObject({
      id: s.id,
      profile: {},
      timezone: 'Asia/Jerusalem',
      channels: [expect.objectContaining({ id: s.keys.get('channel_connection'), network: 'instagram', status: 'pending' })],
      subscription: expect.objectContaining({ plan: 'basic' }),
    });
    expect(b.costUsd.total).toBeCloseTo(0.125, 6);
    expect(b.costUsd.last24h).toBeCloseTo(0.125, 6);
    expect(await refusal(c.business(randomUUID()))).toMatchObject({ status: 404 });
  });
});

describe('posts', () => {
  it('shows every version newest first, with its approvals (invalidated too), and the publications', async () => {
    const s = await seed(db);
    const post = s.keys.get('post')!;
    const media = s.keys.get('media_asset')!;
    const v2 = randomUUID();
    const msg2 = randomUUID();
    await as('post_version', s.id, (tx) =>
      tx.insert(schema.postVersion).values({
        id: v2,
        businessId: s.id,
        postId: post,
        versionNumber: 2,
        captions: { instagram: { text: 'חלות טריות לשבת', hashtags: ['#מאפייה'] } },
        renderedMedia: { instagram: [media] },
        factSources: [],
        factCheckPassed: true,
        contentHash: 'h2',
      }),
    );
    await as('message', s.id, (tx) =>
      tx.insert(schema.message).values({
        id: msg2,
        businessId: s.id,
        direction: 'inbound',
        kind: 'button_reply',
        provider: 'sim',
        providerMessageId: `btn-${randomUUID()}`,
        fromPhone: '+972501234560',
        toPhone: '+972501234561',
      }),
    );
    // The change invalidated the first approval; the owner approved version 2.
    await db.withBusiness(approvalUpdater, s.id, (tx) => tx.update(schema.approval).set({ invalidatedAt: new Date() }).where(eq(schema.approval.id, s.keys.get('approval')!)));
    await as('approval', s.id, (tx) =>
      tx.insert(schema.approval).values({
        businessId: s.id,
        postId: post,
        postVersionId: v2,
        approvedVersionHash: 'h2',
        approverPhone: '+972501234560',
        messageId: msg2,
        approvedAt: new Date(),
      }),
    );
    await sys((tx) => tx.update(schema.post).set({ currentVersionId: v2 }).where(eq(schema.post.id, post)));

    const posts = await c.posts(s.id);
    expect(posts).toHaveLength(1);
    const p = posts[0]!;
    expect(p).toMatchObject({ id: post, businessId: s.id, status: 'planned', format: 'single', position: 1, weekStart: '2026-11-01', currentVersionId: v2 });
    expect(p.versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(p.versions[0]).toMatchObject({
      id: v2,
      contentHash: 'h2',
      factCheckPassed: true,
      captions: { instagram: { text: 'חלות טריות לשבת', hashtags: ['#מאפייה'] } },
      renderedMedia: { instagram: [media] },
      approvals: [expect.objectContaining({ approvedVersionHash: 'h2', invalidatedAt: null, approvedAt: expect.any(Date) })],
    });
    expect(p.versions[1]!.approvals).toEqual([expect.objectContaining({ id: s.keys.get('approval'), approvedVersionHash: 'h', invalidatedAt: expect.any(Date) })]);
    expect(p.publications).toEqual([
      {
        id: s.keys.get('publication'),
        network: 'instagram',
        status: 'scheduled',
        scheduledFor: expect.any(Date),
        publishedAt: null,
        attempts: 0,
        lastError: null,
        approvedVersionHash: 'h',
      },
    ]);
  });
});

describe('model runs and media', () => {
  it('lists model runs without input and output, and returns one whole run; 404 when missing', async () => {
    const s = await seed(db);
    const runId = s.keys.get('model_run')!;
    const list = await c.modelRuns(s.id);
    expect(list).toEqual([expect.objectContaining({ id: runId, businessId: s.id, task: 'fact_extraction', valid: true, costUsd: expect.any(Number) })]);
    expect(list[0]).not.toHaveProperty('input');
    expect(list[0]).not.toHaveProperty('output');
    const all = await c.modelRuns(undefined, 5);
    expect(all.length).toBeLessThanOrEqual(5);
    for (const r of all) expect(r).not.toHaveProperty('input');

    expect(await c.modelRun(runId)).toMatchObject({ id: runId, input: {}, promptVersion: 1, provider: 'sim' });
    expect(await refusal(c.modelRun(randomUUID()))).toMatchObject({ status: 404 });
  });

  it("returns a media asset's storage path and type; 404 when missing", async () => {
    const s = await seed(db);
    const row = s.rows.get('media_asset')!;
    expect(await c.mediaAsset(s.keys.get('media_asset')!)).toEqual({ storagePath: row.storagePath, mimeType: 'image/jpeg' });
    expect(await refusal(c.mediaAsset(randomUUID()))).toMatchObject({ status: 404 });
  });
});

describe('settings and configuration reads', () => {
  it('returns the global settings with the cost cap as a number', async () => {
    const s = await c.settings();
    expect(typeof s.publishingPaused).toBe('boolean');
    expect(typeof s.agentDailyCostCapUsd).toBe('number');
    expect(s.agentDailyCostCapUsd).toBeGreaterThan(0);
  });

  it('lists the model tasks with their prompt versions and the agent configs', async () => {
    const tasks = await c.modelTasks();
    const fact = tasks.find((t) => t.task === 'fact_extraction')!;
    expect(fact.promptVersions).toContain(fact.activePromptVersion);
    expect(fact.promptVersions).toEqual([...fact.promptVersions].sort((a, b) => a - b));
    expect(typeof fact.maxCostUsd).toBe('number');
    const agents = await c.agentConfigs();
    expect(agents.map((a) => a.agent).sort()).toEqual(['drafts', 'onboarding', 'weekly']);
    expect(typeof agents[0]!.maxTurnCostUsd).toBe('number');
  });
});

describe('writes', () => {
  let s: Seeded;
  let before: Awaited<ReturnType<typeof approvalState>>;
  beforeEach(async () => {
    s = await seed(db);
    before = await approvalState();
    // Every write test ends by checking that no approval or publication row changed (the console
    // never approves, publishes, or changes an approval).
    return async () => {
      const after = await approvalState();
      const mine = (x: typeof after) => ({
        approvals: x.approvals.filter((a) => a.businessId === s.id),
        publications: x.publications.filter((p) => p.businessId === s.id),
      });
      expect(mine(after)).toEqual(mine(before));
    };
  });

  describe('setProfile', () => {
    it('replaces the profile of an active business, renames it, and logs one console_action', async () => {
      await activate(s.id);
      const old = await businessRow(s.id);
      const profile = fullProfile(old.approverPhone, 'מאפיית רחוב הרצל');
      await c.setProfile(s.id, profile, { actor: ACTOR, reason: 'owner asked by phone' });
      const now = await businessRow(s.id);
      expect(now.name).toBe('מאפיית רחוב הרצל');
      expect(now.profile).toMatchObject({ name: 'מאפיית רחוב הרצל', approverPhone: old.approverPhone, postsPerWeek: 3 });
      expect(now.approverPhone).toBe(old.approverPhone);
      const log = await actionsOf(s.id);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ businessId: s.id, actor: ACTOR, action: 'profile', target: s.id, reason: 'owner asked by phone', createdAt: expect.any(Date) });
      expect(JSON.stringify(log[0]!.before)).not.toContain('מאפיית רחוב הרצל');
      expect(JSON.stringify(log[0]!.after)).toContain('מאפיית רחוב הרצל');
      expect((await c.actions(s.id)).map((a) => a.id)).toEqual([log[0]!.id]);
    });

    it('refuses an invalid profile with 400 invalid_profile and writes nothing', async () => {
      await activate(s.id);
      const old = await businessRow(s.id);
      expect(await refusal(c.setProfile(s.id, { name: 'רק שם' }, { actor: ACTOR }))).toEqual({ status: 400, reason: 'invalid_profile' });
      expect(await businessRow(s.id)).toMatchObject({ name: old.name, profile: old.profile });
      expect(await actionsOf(s.id)).toEqual([]);
    });

    it('refuses a change of the approver number with 409 approver_locked and writes nothing', async () => {
      await activate(s.id);
      const old = await businessRow(s.id);
      expect(await refusal(c.setProfile(s.id, fullProfile('+972509999999'), { actor: ACTOR }))).toEqual({ status: 409, reason: 'approver_locked' });
      expect(await businessRow(s.id)).toMatchObject({ name: old.name, profile: old.profile, approverPhone: old.approverPhone });
      expect(await actionsOf(s.id)).toEqual([]);
    });

    it('accepts a partial draft while the business onboards', async () => {
      await c.setProfile(s.id, { name: 'פרחי רינה', field: 'חנות פרחים' }, { actor: ACTOR });
      expect(await businessRow(s.id)).toMatchObject({ status: 'onboarding', name: 'פרחי רינה', profile: { name: 'פרחי רינה', field: 'חנות פרחים' } });
      expect(await actionsOf(s.id)).toEqual([expect.objectContaining({ action: 'profile', actor: ACTOR, reason: null })]);
    });

    it('answers 404 for an unknown business', async () => {
      expect(await refusal(c.setProfile(randomUUID(), { name: 'x' }, { actor: ACTOR }))).toMatchObject({ status: 404 });
    });
  });

  describe('global configuration', () => {
    it('sets the agent daily cost cap and refuses a cap of 0 or less', async () => {
      const original = (await c.settings()).agentDailyCostCapUsd;
      try {
        expect(await refusal(c.setAgentCostCap(0, { actor: ACTOR }))).toMatchObject({ status: 400 });
        expect(await refusal(c.setAgentCostCap(-5, { actor: ACTOR }))).toMatchObject({ status: 400 });
        expect((await c.settings()).agentDailyCostCapUsd).toBe(original);
        await c.setAgentCostCap(original + 1, { actor: ACTOR, reason: 'more room' });
        expect((await c.settings()).agentDailyCostCapUsd).toBe(original + 1);
        const [row] = await sys((tx) =>
          tx.select().from(schema.consoleAction).where(eq(schema.consoleAction.action, 'agent_cost_cap')).orderBy(desc(schema.consoleAction.createdAt)).limit(1),
        );
        expect(row).toMatchObject({ businessId: null, actor: ACTOR, reason: 'more room' });
        expect(JSON.stringify(row!.before)).toContain(String(original));
        expect(JSON.stringify(row!.after)).toContain(String(original + 1));
      } finally {
        await sys((tx) => tx.update(schema.systemControl).set({ agentDailyCostCapUsd: String(original) }).where(eq(schema.systemControl.id, 1)));
      }
    });

    it("changes an agent's limits; 404 for an unknown agent, 400 for bad values", async () => {
      const original = (await c.agentConfigs()).find((a) => a.agent === 'drafts')!;
      try {
        expect(await refusal(c.setAgentConfig('nobody', { maxSteps: 3 }, { actor: ACTOR }))).toMatchObject({ status: 404 });
        for (const bad of [{ maxSteps: 0 }, { maxToolCalls: -1 }, { maxTurnCostUsd: 0 }, { minConfidence: 1.5 }, { minConfidence: -0.1 }, { timeoutMs: 0 }]) {
          expect(await refusal(c.setAgentConfig('drafts', bad, { actor: ACTOR }))).toMatchObject({ status: 400 });
        }
        expect((await c.agentConfigs()).find((a) => a.agent === 'drafts')).toEqual(original);
        const row = await c.setAgentConfig('drafts', { maxRefusals: original.maxRefusals + 1 }, { actor: ACTOR, reason: 'tune' });
        expect(row).toMatchObject({ agent: 'drafts', maxRefusals: original.maxRefusals + 1, maxSteps: original.maxSteps });
        const [log] = await actionsOf('drafts');
        expect(log).toMatchObject({ businessId: null, actor: ACTOR, action: 'agent_config', target: 'drafts', reason: 'tune' });
        expect(log!.before).toMatchObject({ maxRefusals: original.maxRefusals });
        expect(log!.after).toMatchObject({ maxRefusals: original.maxRefusals + 1 });
      } finally {
        await sys((tx) => tx.update(schema.agentConfig).set({ maxRefusals: original.maxRefusals }).where(eq(schema.agentConfig.agent, 'drafts')));
      }
    });

    it("changes a model task's settings; refuses unknown prompt versions and out-of-range values", async () => {
      const original = (await c.modelTasks()).find((t) => t.task === 'fact_extraction')!;
      try {
        expect(await refusal(c.setModelTask('no_such_task', { temperature: 1 }, { actor: ACTOR }))).toMatchObject({ status: 404 });
        expect(await refusal(c.setModelTask('fact_extraction', { activePromptVersion: 999 }, { actor: ACTOR }))).toEqual({ status: 400, reason: 'unknown_prompt_version' });
        for (const bad of [{ temperature: 2.5 }, { temperature: -0.1 }, { maxCostUsd: 0 }, { maxRetries: 6 }, { maxRetries: -1 }, { maxRetries: 1.5 }]) {
          expect(await refusal(c.setModelTask('fact_extraction', bad, { actor: ACTOR }))).toMatchObject({ status: 400 });
        }
        expect((await c.modelTasks()).find((t) => t.task === 'fact_extraction')).toEqual(original);

        const temperature = original.temperature === 0.5 ? 0.25 : 0.5;
        const row = await c.setModelTask('fact_extraction', { temperature, activePromptVersion: original.activePromptVersion }, { actor: ACTOR, reason: 'steadier' });
        expect(row).toMatchObject({ task: 'fact_extraction', temperature, provider: original.provider, activePromptVersion: original.activePromptVersion });
        const [log] = await actionsOf('fact_extraction');
        expect(log).toMatchObject({ businessId: null, actor: ACTOR, action: 'model_task_config', target: 'fact_extraction', reason: 'steadier' });
        expect(log!.before).toMatchObject({ temperature: original.temperature });
        expect(log!.after).toMatchObject({ temperature });
      } finally {
        await sys((tx) => tx.update(schema.modelTaskConfig).set({ temperature: original.temperature }).where(eq(schema.modelTaskConfig.task, 'fact_extraction')));
      }
    });
  });
});

describe('the console never approves or publishes', () => {
  it('has no service method that approves or publishes', () => {
    expect(Object.keys(c).filter((k) => /approv|publish/i.test(k))).toEqual([]);
  });

  it('registers no POST route that approves or publishes (a publication retry is allowed)', async () => {
    const app = Fastify();
    const routes: Array<{ method: string; url: string }> = [];
    app.addHook('onRoute', (r) => {
      for (const method of [r.method].flat()) routes.push({ method, url: r.url });
    });
    registerConsoleRoutes(app, { console: c, auth: { mode: 'dev-bypass', actor: ACTOR }, log: () => {}, readMedia: async () => new Uint8Array() });
    await app.ready();
    const posts = routes.filter((r) => r.method === 'POST').map((r) => r.url);
    expect(posts).toContain('/console/api/publications/:id/retry');
    expect(posts.filter((u) => /approv|publish/i.test(u))).toEqual([]);
    // And no route writes an approval under another verb.
    expect(routes.filter((r) => r.method !== 'GET' && r.method !== 'HEAD' && /approv/i.test(r.url))).toEqual([]);
    await app.close();
  });

  it('leaves approvals and publications unchanged across every kind of console write', async () => {
    const s = await seed(db);
    await activate(s.id);
    const before = await sys(async (tx) => ({
      approvals: await tx.select().from(schema.approval).where(eq(schema.approval.businessId, s.id)),
      publications: await tx.select().from(schema.publication).where(eq(schema.publication.businessId, s.id)),
      post: await tx.select().from(schema.post).where(and(eq(schema.post.businessId, s.id))),
    }));
    const old = await businessRow(s.id);
    await c.setProfile(s.id, fullProfile(old.approverPhone), { actor: ACTOR });
    await refusal(c.setProfile(s.id, fullProfile('+972509999998'), { actor: ACTOR }));
    await refusal(c.setProfile(s.id, { name: 'x' }, { actor: ACTOR }));
    const after = await sys(async (tx) => ({
      approvals: await tx.select().from(schema.approval).where(eq(schema.approval.businessId, s.id)),
      publications: await tx.select().from(schema.publication).where(eq(schema.publication.businessId, s.id)),
      post: await tx.select().from(schema.post).where(and(eq(schema.post.businessId, s.id))),
    }));
    expect(after).toEqual(before);
  });
});
