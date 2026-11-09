import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { inserter, rowsFor, seed, tableName } from '../../test/db/rows.js';
import { createDatabase, createPostgresSimulatorStore } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { simulatedWorld } from '../../src/simulated.js';
import { createSandbox, type Sandbox } from './sandbox.js';

// The dev sandbox's "new sign-up from this number" (docs/deployment.md, "The sandbox"), on the
// Postgres simulator store as dev runs it: the new sign-up's chat starts empty, both sides.

const OWNER = '+972501234577';
const OTHER = '+972501234578';
const BUSINESS_PHONE = '+972521111177';
const PUBLIC_BASE_URL = 'https://postly-dev-web.example.test';
const SECRET = 'test-only';
const NAMESPACE = `sandbox-db-${Date.now()}`;

const store = createPostgresSimulatorStore(inject('simulatorStoreUrl'));
const db = createDatabase(inject('databaseUrls'), { max: 2 });
// Web plays the other side of the webhook; this test needs only that it accepts the posts.
let web: Server;
let sandbox: Sandbox;
const world = simulatedWorld({ store, namespace: NAMESPACE, webhookSecret: SECRET, publicBaseUrl: PUBLIC_BASE_URL, businessNumber: BUSINESS_PHONE });

beforeAll(async () => {
  web = createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(200).end());
  });
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
  sandbox = await createSandbox({
    databaseUrls: inject('databaseUrls'),
    store,
    namespace: NAMESPACE,
    webhookSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE_URL,
    webUrl: `http://127.0.0.1:${(web.address() as AddressInfo).port}`,
    businessNumber: BUSINESS_PHONE,
    ownerPhone: OWNER,
  });
});

afterAll(async () => {
  await sandbox?.close();
  await new Promise((resolve) => web?.close(resolve));
  await store.close();
  await db.close();
});

describe('sandbox sign-up', () => {
  it('a new sign-up from the number starts an empty chat: no messages from it and none to it; other numbers keep theirs', async () => {
    const first = await sandbox.signUp();
    await sandbox.send({ kind: 'text', text: 'היי, נרשמתי לפוסטלי' });
    await world.messaging.run((sim) => sim.sendText({ to: OWNER, text: 'שלום! איך קוראים לעסק?' }));
    await world.messaging.run((sim) => sim.sendText({ to: OTHER, text: 'הודעה למספר אחר' }));
    expect((await sandbox.state()).messages.map((m) => m.direction)).toEqual(['from_owner', 'to_owner']);

    const second = await sandbox.signUp();

    expect(second).not.toBe(first);
    const state = await sandbox.state();
    expect(state.business).toMatchObject({ id: second, status: 'onboarding' });
    expect(state.messages).toEqual([]);
    expect(await sandbox.transcript()).toEqual([]);
    expect((await world.messaging.run((sim) => sim.sentTo(OTHER))).map((m) => m.request)).toEqual([{ to: OTHER, text: 'הודעה למספר אחר' }]);

    // The new onboarding's chat holds only what comes after the sign-up.
    await sandbox.send({ kind: 'text', text: 'שוב שלום' });
    await world.messaging.run((sim) => sim.sendText({ to: OWNER, text: 'ברוכים הבאים' }));
    expect((await sandbox.state()).messages.map((m) => m.text)).toEqual(['שוב שלום', 'ברוכים הבאים']);
  });

  it("the feed shows only the current sign-up's posts; the earlier ones stay on the publishing simulator", async () => {
    const first = await sandbox.signUp();
    await world.publishing.run(async (sim) => {
      const providerAccountId = sim.connect(first, 'instagram');
      await sim.publish({
        idempotencyKey: randomUUID(),
        providerAccountId,
        network: 'instagram',
        caption: 'חלות לשבת',
        mediaUrls: ['https://storage.example.test/challah.png'],
        format: 'single',
        scheduledFor: new Date().toISOString(),
      });
    });
    expect((await sandbox.state()).feed.instagram.map((p) => p.caption)).toEqual(['חלות לשבת']);

    await sandbox.signUp();

    expect((await sandbox.state()).feed).toEqual({ instagram: [], facebook: [] });
    expect((await world.publishing.run((sim) => sim.posts)).map((p) => p.request.caption)).toContain('חלות לשבת');
  });
});

describe('sandbox publish now (dev demos)', () => {
  const DAY = 86_400_000;
  const sandboxServer = async (sb: Sandbox) => {
    const server = createServer((req, res) => sb.handle(req, res, () => res.writeHead(404).end()));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, close: () => new Promise((resolve) => server.close(resolve)) };
  };
  const publications = (ids: string[]) =>
    db.withSystem('console', (tx) => tx.select().from(schema.publication).where(inArray(schema.publication.id, ids)));

  it("moves only the current sign-up's scheduled publications to now; it touches no other row or business", async () => {
    // The current sign-up, with a post approved and scheduled for days ahead, and one already published.
    const mine = await sandbox.signUp();
    // Sign-up already made its conversation_state.
    for (const [table, row] of rowsFor(mine).filter(([t]) => tableName(t) !== 'conversation_state')) {
      await db.withBusiness(inserter(tableName(table)), mine, (tx) => tx.insert(table).values(row));
    }
    const [seeded] = await db.withSystem('console', (tx) => tx.select().from(schema.publication).where(eq(schema.publication.businessId, mine)));
    const later = new Date(Date.now() + 3 * DAY);
    await db.withSystem('console', (tx) => tx.update(schema.publication).set({ scheduledFor: later }).where(eq(schema.publication.id, seeded!.id)));
    const published = { ...seeded!, id: randomUUID(), network: 'facebook' as const, status: 'published' as const, scheduledFor: later, publishedAt: new Date() };
    await db.withBusiness('publishing', mine, (tx) => tx.insert(schema.publication).values(published));
    // Another business's scheduled publication.
    const other = await seed(db);
    const otherPub = other.keys.get('publication')!;
    await db.withSystem('console', (tx) => tx.update(schema.publication).set({ scheduledFor: later }).where(eq(schema.publication.id, otherPub)));
    const approvalsBefore = await db.withSystem('console', (tx) => tx.select().from(schema.approval).where(inArray(schema.approval.businessId, [mine, other.id])));

    const server = await sandboxServer(sandbox);
    try {
      const before = Date.now();
      const res = await fetch(`${server.url}/api/publish-now`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ moved: 1 });

      const after = await publications([seeded!.id, published.id, otherPub]);
      const byId = new Map(after.map((p) => [p.id, p]));
      const moved = byId.get(seeded!.id)!;
      expect(moved.status).toBe('scheduled');
      expect(moved.scheduledFor.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(moved.scheduledFor.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      // The approval and its hash are untouched; the publishing job checks them as always.
      expect(moved.approvalId).toBe(seeded!.approvalId);
      expect(moved.approvedVersionHash).toBe(seeded!.approvedVersionHash);
      expect(byId.get(published.id)!.scheduledFor.getTime()).toBe(later.getTime());
      expect(byId.get(otherPub)!.scheduledFor.getTime()).toBe(later.getTime());
      expect(await db.withSystem('console', (tx) => tx.select().from(schema.approval).where(inArray(schema.approval.businessId, [mine, other.id])))).toEqual(approvalsBefore);

      // Nothing left to move: the due one stays as it is.
      expect(await (await fetch(`${server.url}/api/publish-now`, { method: 'POST' })).json()).toEqual({ moved: 0 });
    } finally {
      await server.close();
    }
  });

  it('is refused outside the simulated environments', async () => {
    const stage = await createSandbox({
      databaseUrls: inject('databaseUrls'),
      store,
      namespace: NAMESPACE,
      webhookSecret: SECRET,
      publicBaseUrl: PUBLIC_BASE_URL,
      webUrl: sandbox.webUrl,
      businessNumber: BUSINESS_PHONE,
      ownerPhone: OWNER,
      env: 'stage',
    });
    const server = await sandboxServer(stage);
    try {
      const res = await fetch(`${server.url}/api/publish-now`, { method: 'POST' });
      expect(res.status).toBe(403);
    } finally {
      await server.close();
      await stage.close();
    }
  });
});
