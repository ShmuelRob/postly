import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { inserter, seed, type Seeded } from '../../../test/db/rows.js';
import { createDatabase, onlyLogins, PROCESS_LOGINS, type Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createWorkflow } from '../workflow/index.js';
import { createConsole, registerConsoleRoutes } from './index.js';

// The redesigned console's routes and page (technical-design.md, "Console (Phase 1)"; security.md,
// "Media in the console"), through Fastify inject with the local dev bypass. Written from the docs
// and the shared contract before the implementation.

const db = createDatabase(inject('databaseUrls'), { max: 4 });
const consoleDb = createDatabase(onlyLogins(inject('databaseUrls'), PROCESS_LOGINS.console), { max: 2 });
const workflow = createWorkflow(consoleDb, { rejected: () => {} });
const service = createConsole(consoleDb, workflow);
const ACTOR = 'team@postly';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const reads: string[] = [];

// With the media store wired (src/main.ts passes the app's media store `read`), and without it.
const app = Fastify();
registerConsoleRoutes(app, {
  console: service,
  auth: { mode: 'dev-bypass', actor: ACTOR },
  log: () => {},
  readMedia: async (storagePath: string) => {
    reads.push(storagePath);
    return PNG;
  },
});
const bare = Fastify();
registerConsoleRoutes(bare, { console: service, auth: { mode: 'dev-bypass', actor: ACTOR }, log: () => {} });

afterAll(async () => {
  await app.close();
  await bare.close();
  await consoleDb.close();
  await db.close();
});

const sys = <T>(fn: (tx: Tx) => Promise<T>) => db.withSystem('console', fn);
const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, type: String(res.headers['content-type'] ?? ''), body: res.body, res };
};
const post = async (url: string, payload: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => {
  const res = await app.inject({ method: 'POST', url: `/console/api${url}`, headers, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : undefined };
};

const HEBREW = 'שלום, השבוע יש לנו חלות חדשות';
let s: Seeded;
let png: string;
/** Assets whose stored type must never be served inline (stored XSS, security.md "Media in the console"). */
const unsafe: Record<string, string> = {};

beforeAll(async () => {
  s = await seed(db);
  await sys((tx) => tx.update(schema.business).set({ name: 'מאפיית השכונה' }).where(eq(schema.business.id, s.id)));
  await db.withBusiness(inserter('message'), s.id, (tx) =>
    tx.insert(schema.message).values({
      businessId: s.id,
      direction: 'inbound',
      kind: 'text',
      provider: 'sim',
      providerMessageId: `in-${randomUUID()}`,
      fromPhone: '+972501234560',
      toPhone: '+972501234561',
      body: HEBREW,
    }),
  );
  png = randomUUID();
  await db.withBusiness(inserter('media_asset'), s.id, (tx) =>
    tx.insert(schema.mediaAsset).values({ id: png, businessId: s.id, kind: 'rendered', source: 'render', storagePath: `renders/${png}.png`, mimeType: 'image/png', sha256: 'x' }),
  );
  for (const mimeType of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'image/heic', 'image/png; charset=utf-8', 'IMAGE/SVG+XML']) {
    const id = randomUUID();
    unsafe[mimeType] = id;
    await db.withBusiness(inserter('media_asset'), s.id, (tx) =>
      tx.insert(schema.mediaAsset).values({ id, businessId: s.id, kind: 'photo', source: 'owner', storagePath: `owner/${id}`, mimeType, sha256: 'x' }),
    );
  }
});

describe('JSON reads', () => {
  it('answers every GET with 200 JSON', async () => {
    const run = s.keys.get('model_run')!;
    for (const url of [
      '/console/api/overview',
      '/console/api/business-rows',
      `/console/api/businesses/${s.id}`,
      `/console/api/businesses/${s.id}/posts`,
      `/console/api/businesses/${s.id}/model-runs`,
      '/console/api/model-runs',
      '/console/api/model-runs?limit=5',
      `/console/api/model-runs/${run}`,
      '/console/api/settings',
      '/console/api/model-tasks',
      '/console/api/agent-config',
      '/console/api/actions',
      `/console/api/actions?businessId=${s.id}`,
    ]) {
      const res = await get(url);
      expect({ url, status: res.status }).toEqual({ url, status: 200 });
      expect(res.type).toContain('application/json');
      JSON.parse(res.body);
    }
  });

  it('returns the read models', async () => {
    expect(JSON.parse((await get(`/console/api/businesses/${s.id}`)).body)).toMatchObject({ id: s.id, name: 'מאפיית השכונה' });
    const rows = JSON.parse((await get('/console/api/business-rows')).body) as any[];
    expect(rows.find((r) => r.id === s.id)).toMatchObject({ lastMessage: { body: HEBREW } });
    const runs = JSON.parse((await get(`/console/api/businesses/${s.id}/model-runs`)).body) as any[];
    expect(runs[0]).not.toHaveProperty('input');
    expect(JSON.parse((await get(`/console/api/model-runs/${s.keys.get('model_run')}`)).body)).toHaveProperty('input');
    expect(JSON.parse((await get('/console/api/model-runs?limit=2')).body).length).toBeLessThanOrEqual(2);
  });

  it('answers 404 for a missing business or model run, and 400 for a bad id or limit', async () => {
    expect((await get(`/console/api/businesses/${randomUUID()}`)).status).toBe(404);
    expect((await get(`/console/api/model-runs/${randomUUID()}`)).status).toBe(404);
    expect((await get('/console/api/model-runs/not-a-uuid')).status).toBe(400);
    expect((await get('/console/api/model-runs?limit=501')).status).toBe(400);
  });
});

describe('writes', () => {
  it('refuses a body with an unknown key (400) and a POST without a JSON content type (415)', async () => {
    expect((await post(`/businesses/${s.id}/profile`, { profile: { name: 'x' }, extra: 1 })).status).toBe(400);
    expect((await post('/system/agent-cost-cap', { usd: 10, by: 'someone' })).status).toBe(400);
    expect((await post('/agent-config/drafts', { maxSteps: 12, provider: 'x' })).status).toBe(400);
    expect((await post('/model-tasks/fact_extraction', { provider: 'openai' })).status).toBe(400);
    expect((await post(`/businesses/${s.id}/profile`, 'profile=x', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect(await sys((tx) => tx.select().from(schema.consoleAction).where(eq(schema.consoleAction.target, s.id)))).toEqual([]);
  });

  it('maps the refusals: invalid_profile, approver_locked, 400 cost cap, 404 agent, unknown_prompt_version', async () => {
    const other = await seed(db);
    await sys((tx) => tx.update(schema.business).set({ status: 'active' }).where(eq(schema.business.id, other.id)));
    expect(await post(`/businesses/${other.id}/profile`, { profile: { name: 'רק שם' } })).toMatchObject({ status: 400, body: { reason: 'invalid_profile' } });
    expect((await post('/system/agent-cost-cap', { usd: 0 })).status).toBe(400);
    expect((await post('/agent-config/nobody', { maxSteps: 3 })).status).toBe(404);
    expect((await post('/agent-config/drafts', { minConfidence: 2 })).status).toBe(400);
    expect(await post('/model-tasks/fact_extraction', { activePromptVersion: 999 })).toMatchObject({ status: 400, body: { reason: 'unknown_prompt_version' } });
    expect((await post('/model-tasks/fact_extraction', { temperature: 3 })).status).toBe(400);
    const b = (await sys((tx) => tx.select().from(schema.business).where(eq(schema.business.id, other.id))))[0]!;
    expect(
      await post(`/businesses/${other.id}/profile`, {
        profile: {
          name: 'x',
          field: 'y',
          mainProducts: ['z'],
          location: { city: 'חולון', address: 'הרצל 1', hours: '8-20', fulfillment: ['pickup'] },
          differentiator: 'd',
          channels: ['instagram'],
          style: 'clean',
          approverPhone: b.approverPhone === '+972509999997' ? '+972509999996' : '+972509999997',
        },
      }),
    ).toMatchObject({ status: 409, body: { reason: 'approver_locked' } });
  });

  it('takes the actor from the sign-in, never from the body', async () => {
    const other = await seed(db);
    expect((await post(`/businesses/${other.id}/profile`, { profile: { name: 'x' }, actor: 'mallory' })).status).toBe(400);
    expect((await post(`/businesses/${other.id}/profile`, { profile: { name: 'פרחי רינה' }, reason: 'typo' })).status).toBe(200);
    const rows = await sys((tx) => tx.select().from(schema.consoleAction).where(eq(schema.consoleAction.target, other.id)).orderBy(desc(schema.consoleAction.createdAt)));
    expect(rows).toEqual([expect.objectContaining({ actor: ACTOR, action: 'profile', reason: 'typo', businessId: other.id })]);
    const log = JSON.parse((await get(`/console/api/actions?businessId=${other.id}`)).body) as any[];
    expect(log).toEqual([expect.objectContaining({ actor: ACTOR, action: 'profile' })]);
  });
});

describe('media', () => {
  it('streams the asset bytes with its type and no caching', async () => {
    const res = await get(`/console/media/${png}`);
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/^image\/png/);
    expect(res.res.headers['cache-control']).toBe('private, no-store');
    expect(new Uint8Array(res.res.rawPayload)).toEqual(PNG);
    expect(reads).toContain(`renders/${png}.png`);
  });

  it('sends nosniff and a sandbox policy with every media response', async () => {
    for (const id of [png, ...Object.values(unsafe)]) {
      const res = await get(`/console/media/${id}`);
      expect(res.status).toBe(200);
      expect(res.res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.res.headers['content-security-policy']).toBe('sandbox');
      expect(res.res.headers['cache-control']).toBe('private, no-store');
    }
    expect((await get(`/console/media/${png}`)).res.headers['content-disposition']).toBeUndefined();
  });

  it('serves only raster image types inline; any other stored type downloads as octet-stream', async () => {
    for (const [mimeType, id] of Object.entries(unsafe)) {
      const res = await get(`/console/media/${id}`);
      expect(res.type, mimeType).toMatch(/^application\/octet-stream/);
      expect(res.res.headers['content-disposition'], mimeType).toMatch(/^attachment/);
      expect(new Uint8Array(res.res.rawPayload)).toEqual(PNG);
    }
  });

  it('answers 404 for an unknown asset, and when no media store is wired', async () => {
    expect((await get(`/console/media/${randomUUID()}`)).status).toBe(404);
    expect((await bare.inject({ method: 'GET', url: `/console/media/${png}` })).statusCode).toBe(404);
  });
});

describe('page', () => {
  const page = async (query: string) => {
    const res = await get(`/console${query}`);
    expect(res.status).toBe(200);
    expect(res.type).toContain('text/html');
    return res.body;
  };
  const testid = (id: string) => new RegExp(`data-testid="${id}"`);
  const noApproveOrPublish = (html: string) => {
    expect(html).not.toMatch(/data-action="[^"]*(approv|publish)/i);
    expect(html).not.toMatch(/<button[^>]*>\s*(approve|publish)/i);
  };

  it('renders the overview by default and with ?tab=overview', async () => {
    for (const q of ['', '?tab=overview']) {
      const html = await page(q);
      for (const id of ['tab-overview', 'tab-manage', 'tab-conversations', 'overview']) expect(html).toMatch(testid(id));
      noApproveOrPublish(html);
    }
  });

  it('renders the manage tab with the review queue', async () => {
    const html = await page('?tab=manage');
    expect(html).toMatch(testid('manage'));
    expect(html).toMatch(testid('review-queue'));
    noApproveOrPublish(html);
  });

  it('renders the conversations tab with the list', async () => {
    const html = await page(`?tab=conversations&q=${encodeURIComponent('מאפיית השכונה')}`);
    expect(html).toMatch(testid('conversations'));
    expect(html).toMatch(testid('conversation-list'));
    expect(html).toContain('מאפיית השכונה');
    noApproveOrPublish(html);
  });

  it("renders a business's chat in Hebrew with dir=auto, and its client panel", async () => {
    const html = await page(`?business=${s.id}&tab=conversations`);
    for (const id of ['conversations', 'conversation-list', 'chat', 'client-panel', 'bubble-inbound']) expect(html).toMatch(testid(id));
    expect(html).toContain(HEBREW);
    // The Hebrew bubble sits in an element with dir="auto".
    const at = html.indexOf(HEBREW);
    const opening = html.slice(0, at).match(/<[a-z]+[^>]*>(?:\s*<[a-z]+[^>]*>)*\s*$/i)?.[0] ?? '';
    expect(opening).toContain('dir="auto"');
    // The client panel shows the approval state only.
    expect(html).toMatch(testid('post-card'));
    noApproveOrPublish(html);
  });

  it('renders a model run on its own view', async () => {
    const html = await page(`?run=${s.keys.get('model_run')}`);
    expect(html).toMatch(testid('model-run'));
    expect(html).toContain('fact_extraction');
    noApproveOrPublish(html);
  });
});
