import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, afterEach, describe, expect, inject, it } from 'vitest';
import { seed } from '../../../test/db/rows.js';
import { createDatabase, onlyLogins, PROCESS_LOGINS, type Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createWorkflow } from '../workflow/index.js';
import { createConsole, registerConsoleRoutes } from './index.js';

// Every console action goes through the console API (technical-design.md, "Console (Phase 1)").

const db = createDatabase(inject('databaseUrls'), { max: 4 });
// The console and its workflow calls get only the console process's logins (D9, WP-84): an action that
// needs any other login fails here.
const consoleDb = createDatabase(onlyLogins(inject('databaseUrls'), PROCESS_LOGINS.console), { max: 2 });
const workflow = createWorkflow(consoleDb, { rejected: () => {} });
const app = Fastify();
// Signed in as `team@postly` through the local dev bypass (the actor of every action, D4).
registerConsoleRoutes(app, { console: createConsole(consoleDb, workflow), auth: { mode: 'dev-bypass', actor: 'team@postly' }, log: () => {} });
afterAll(async () => {
  await app.close();
  await consoleDb.close();
  await db.close();
});

const api = async (method: 'GET' | 'POST', url: string, payload?: object) => {
  const res = await app.inject({ method, url: `/console/api${url}`, ...(method === 'POST' ? { payload: payload ?? {} } : {}) });
  return { status: res.statusCode, body: res.json() as any };
};
const read = <T>(fn: (tx: Tx) => Promise<T>) => db.withSystem('console', fn);
const row = async <T extends typeof schema.consoleItem | typeof schema.publication | typeof schema.post | typeof schema.business>(
  table: T,
  id: string,
) => read(async (tx) => (await tx.select().from(table as any).where(eq((table as any).id, id)))[0] as any);
const handoffOf = async (b: string) =>
  read(async (tx) => (await tx.select().from(schema.conversationState).where(eq(schema.conversationState.businessId, b)))[0]?.handoffAt);

describe('local-only guard', () => {
  it('refuses requests that are not from the loopback address', async () => {
    const res = await app.inject({ method: 'GET', url: '/console/api/businesses', remoteAddress: '203.0.113.7' });
    expect(res.statusCode).toBe(403);
  });
});

describe('reading', () => {
  it('lists businesses, a conversation, drafts and open items', async () => {
    const s = await seed(db);
    const businesses = await api('GET', '/businesses');
    expect(businesses.body.find((b: any) => b.id === s.id)).toMatchObject({ status: 'onboarding', handoffAt: null });
    const messages = await api('GET', `/businesses/${s.id}/messages`);
    expect(messages.body).toHaveLength(1);
    const drafts = await api('GET', `/drafts?businessId=${s.id}`);
    expect(drafts.body).toEqual([expect.objectContaining({ id: s.keys.get('post'), status: 'planned', version: expect.objectContaining({ contentHash: 'h' }) })]);
    const items = await api('GET', '/items');
    expect(items.body.some((i: any) => i.id === s.keys.get('console_item'))).toBe(true);
  });
});

describe('console items', () => {
  it('resolves an item', async () => {
    const s = await seed(db);
    const id = s.keys.get('console_item')!;
    expect((await api('POST', `/items/${id}/resolve`)).status).toBe(200);
    expect(await row(schema.consoleItem, id)).toMatchObject({ status: 'resolved', resolvedAt: expect.any(Date) });
    expect((await api('GET', '/items')).body.some((i: any) => i.id === id)).toBe(false);
  });

  it('routes an item to a person: handoff starts and the item is resolved', async () => {
    const s = await seed(db);
    const id = await read(async (tx) => (await tx.insert(schema.consoleItem).values({ businessId: s.id, kind: 'draft_failed' }).returning())[0]!.id);
    expect((await api('POST', `/items/${id}/route`)).status).toBe(200);
    expect(await handoffOf(s.id)).toBeInstanceOf(Date);
    expect((await row(schema.consoleItem, id)).status).toBe('resolved');
  });

  it('refuses to route an item without a business', async () => {
    const id = await read(async (tx) => (await tx.insert(schema.consoleItem).values({ businessId: null, kind: 'unknown_number' }).returning())[0]!.id);
    expect((await api('POST', `/items/${id}/route`)).status).toBe(409);
    expect((await row(schema.consoleItem, id)).status).toBe('open');
  });

  it('answers 404 for an unknown item', async () => {
    expect((await api('POST', `/items/${randomUUID()}/resolve`)).status).toBe(404);
  });
});

describe('handoff', () => {
  it('starts and clears a handoff', async () => {
    const s = await seed(db);
    expect((await api('POST', `/businesses/${s.id}/handoff`)).status).toBe(200);
    expect(await handoffOf(s.id)).toBeInstanceOf(Date);
    expect((await api('POST', `/businesses/${s.id}/handoff/clear`)).status).toBe(200);
    expect(await handoffOf(s.id)).toBeNull();
  });
});

describe('retry', () => {
  it('retries a failed publication and its failed post, and resolves its item', async () => {
    const s = await seed(db);
    const pub = s.keys.get('publication')!;
    const post = s.keys.get('post')!;
    const item = await read(async (tx) => {
      await tx.update(schema.publication).set({ status: 'failed' }).where(eq(schema.publication.id, pub));
      await tx.update(schema.post).set({ status: 'failed' }).where(eq(schema.post.id, post));
      return (await tx.insert(schema.consoleItem).values({ businessId: s.id, kind: 'publication_failed', referenceId: pub }).returning())[0]!.id;
    });
    expect((await api('POST', `/publications/${pub}/retry`)).status).toBe(200);
    expect((await row(schema.publication, pub)).status).toBe('retry_pending');
    expect((await row(schema.post, post)).status).toBe('publishing');
    expect((await row(schema.consoleItem, item)).status).toBe('resolved');
  });

  it('refuses to retry a publication that has not failed', async () => {
    const s = await seed(db);
    const pub = s.keys.get('publication')!;
    const res = await api('POST', `/publications/${pub}/retry`);
    expect(res.status).toBe(409);
    expect((await row(schema.publication, pub)).status).toBe('scheduled');
  });
});

describe('pause', () => {
  afterEach(() => workflow.setGlobalPause(false, 'test'));

  it('pauses a business and resumes it only with a verified channel', async () => {
    const s = await seed(db);
    await read((tx) => tx.update(schema.business).set({ status: 'active' }).where(eq(schema.business.id, s.id)));
    expect((await api('POST', `/businesses/${s.id}/pause`)).status).toBe(200);
    expect((await row(schema.business, s.id)).status).toBe('paused');
    const refused = await api('POST', `/businesses/${s.id}/resume`);
    expect(refused).toMatchObject({ status: 409, body: { reason: 'guard_failed' } });
    await read((tx) => tx.update(schema.channelConnection).set({ status: 'verified' }).where(eq(schema.channelConnection.businessId, s.id)));
    expect((await api('POST', `/businesses/${s.id}/resume`)).status).toBe(200);
    expect((await row(schema.business, s.id)).status).toBe('active');
    // The workflow audit trail (WP-46) names the signed-in team member (WP-82).
    const events = await read((tx) => tx.select().from(schema.workflowEvent).where(eq(schema.workflowEvent.businessId, s.id)).orderBy(schema.workflowEvent.createdAt));
    expect(events.filter((e) => e.machine === 'business').map((e) => [e.event, e.outcome, e.actor])).toEqual([
      ['PAUSE', 'applied', 'team:team@postly'],
      ['RESUME', 'rejected', 'team:team@postly'],
      ['RESUME', 'applied', 'team:team@postly'],
    ]);
  });

  it('pauses and resumes all publishing', async () => {
    expect((await api('POST', '/system/pause', { reason: 'incident' })).status).toBe(200);
    expect((await api('GET', '/system')).body).toMatchObject({ publishingPaused: true, pausedBy: 'team@postly', pausedReason: 'incident' });
    expect((await api('POST', '/system/resume', {})).status).toBe(200);
    expect((await api('GET', '/system')).body).toMatchObject({ publishingPaused: false });
  });

  it('records the signed-in team member, never a name from the body (D4)', async () => {
    expect((await api('POST', '/system/pause', {})).status).toBe(200);
    expect((await api('GET', '/system')).body).toMatchObject({ publishingPaused: true, pausedBy: 'team@postly', pausedReason: null });
    expect((await api('POST', '/system/pause', { by: 'someone else', reason: 'incident' })).status).toBe(200);
    expect((await api('GET', '/system')).body).toMatchObject({ pausedBy: 'team@postly', pausedReason: 'incident (by: someone else)' });
  });
});

describe('page', () => {
  it('renders the console page', async () => {
    await seed(db);
    const res = await app.inject({ method: 'GET', url: '/console' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Postly console');
  });
});
