import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { WindowClosedError } from '../../contracts/providers/messaging.js';
import { createDatabase } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { buildServer } from '../../server.js';
import { MessagingSimulator } from '../../simulators/messaging.js';
import { createMessaging, type InboundBurst, type Timers, WEBHOOK_PATH } from './index.js';

const db = createDatabase(inject('databaseUrls'), { max: 2 });
afterAll(() => db.close());

const BUSINESS_NUMBER = '+972521111111';

/** Timers the test fires by hand. */
function manualTimers() {
  const due = new Map<number, () => void>();
  let next = 1;
  const timers: Timers = {
    set: (fn) => {
      due.set(next, fn);
      return next++;
    },
    clear: (h) => void due.delete(h as number),
  };
  return { timers, fire: () => [...due.values()].forEach((fn) => fn()), pending: () => due.size };
}

async function setup(options: { now?: () => Date } = {}) {
  const businessId = randomUUID();
  const owner = `+97250${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
  await db.withBusiness('workflow', businessId, (tx) => tx.insert(schema.business).values({ id: businessId, name: 'עסק', approverPhone: owner }));
  const sim = new MessagingSimulator({ businessNumber: BUSINESS_NUMBER, ...(options.now ? { now: options.now } : {}) });
  // Provider message ids are unique across the whole table, and every simulator counts from 1.
  const inbound = sim.inbound.bind(sim);
  sim.inbound = (from, content) => ({ ...inbound(from, content), providerMessageId: `SM-${randomUUID()}` });
  const bursts: InboundBurst[] = [];
  const clock = manualTimers();
  const messaging = createMessaging({
    db,
    provider: sim,
    businessNumber: BUSINESS_NUMBER,
    handler: { handleInbound: async (b) => void bursts.push(b) },
    timers: clock.timers,
    ...(options.now ? { now: options.now } : {}),
  });
  return { businessId, owner, sim, bursts, clock, messaging };
}

describe('messaging module', () => {
  it('stores a duplicate webhook once and hands it over once', async () => {
    const { businessId, owner, sim, bursts, messaging } = await setup();
    const hook = sim.webhook(sim.inboundText(owner, 'שלום'));
    expect(await messaging.handleWebhook(hook)).toEqual(['accepted']);
    expect(await messaging.handleWebhook(hook)).toEqual(['duplicate']);
    await messaging.flushBursts();
    expect(bursts).toHaveLength(1);
    const rows = await db.withBusiness('messaging', businessId, (tx) => tx.select().from(schema.message));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.processedAt).not.toBeNull();
  });

  it('merges a burst until the quiet period passes, and hands button replies over at once', async () => {
    const { owner, sim, bursts, clock, messaging } = await setup();
    await messaging.receive(sim.inboundText(owner, 'יש מבצע'));
    await messaging.receive(sim.inboundImage(owner, 'ME-1', 'חלות'));
    await messaging.receive(sim.inboundText(owner, '2 ב-20'));
    expect(bursts).toHaveLength(0);
    expect(clock.pending()).toBe(1);
    clock.fire();
    await expect.poll(() => bursts.length).toBe(1);
    expect(bursts[0]?.text).toBe('יש מבצע\nחלות\n2 ב-20');
    expect(bursts[0]?.messages).toHaveLength(3);

    await messaging.receive(sim.inboundText(owner, 'עוד משהו'));
    await messaging.receive(sim.inboundButtonTap(owner, { action: 'approve', postId: randomUUID(), versionHash: 'a'.repeat(64) }));
    expect(bursts.map((b) => b.messages.map((m) => m.content.kind))).toEqual([
      ['text', 'image', 'text'],
      ['text'],
      ['button_reply'],
    ]);
  });

  it('routes an unknown number to the console without replying or handing it over', async () => {
    const { sim, bursts, messaging } = await setup();
    const stranger = '+972539999999';
    const msg = sim.inboundButtonTap(stranger, { action: 'approve', postId: randomUUID(), versionHash: 'b'.repeat(64) });
    expect(await messaging.receive(msg)).toBe('unknown_number');
    expect(await messaging.receive(msg)).toBe('duplicate');
    await messaging.flushBursts();
    expect(bursts).toHaveLength(0);
    expect(sim.sent).toHaveLength(0);
    const items = await db.withSystem('console', async (tx) => {
      const [row] = await tx.select().from(schema.message).where(eq(schema.message.providerMessageId, msg.providerMessageId));
      return tx.select().from(schema.consoleItem).where(eq(schema.consoleItem.referenceId, row!.id));
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'unknown_number', businessId: null, status: 'open' });
  });

  it('refuses free-form sends outside the 24-hour window but sends templates', async () => {
    let now = new Date('2026-11-01T10:00:00Z');
    const { businessId, owner, sim, messaging } = await setup({ now: () => now });
    await expect(messaging.sendText(businessId, { to: owner, text: 'היי' })).rejects.toMatchObject({ name: 'WindowClosedError', lastInboundAt: null });
    await messaging.receive(sim.inboundText(owner, 'שלום'));
    now = new Date('2026-11-02T09:00:00Z');
    expect(await messaging.windowClosesAt(businessId, owner)).toEqual(new Date('2026-11-02T10:00:00Z'));
    await messaging.sendText(businessId, { to: owner, text: 'היי' });
    now = new Date('2026-11-02T10:00:01Z');
    await expect(messaging.sendButtons(businessId, { to: owner, text: 'x', buttons: [{ id: 'a', title: 'a' }] })).rejects.toBeInstanceOf(
      WindowClosedError,
    );
    await messaging.sendTemplate(businessId, { to: owner, templateName: 'weekly_reminder', language: 'he', variables: {} });
    expect(sim.sent.map((m) => m.kind)).toEqual(['text', 'template']);
    const outbound = await db.withBusiness('messaging', businessId, (tx) =>
      tx.select().from(schema.message).where(eq(schema.message.direction, 'outbound')),
    );
    expect(outbound.map((m) => m.kind).sort()).toEqual(['template', 'text']);
    await messaging.close();
  });

  it('the webhook route rejects a bad signature and accepts a signed request', async () => {
    const { owner, sim, messaging } = await setup();
    const server = buildServer({ messaging, publicBaseUrl: 'https://postly.example.test' });
    const hook = sim.webhook(sim.inboundText(owner, 'שלום'));
    const bad = await server.inject({ method: 'POST', url: WEBHOOK_PATH, headers: { ...hook.headers, 'x-simulator-signature': 'sha256=00' }, payload: hook.body });
    expect(bad.statusCode).toBe(401);
    const ok = await server.inject({ method: 'POST', url: WEBHOOK_PATH, headers: hook.headers, payload: hook.body });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ outcomes: ['accepted'] });
    await server.close();
  });
});

describe('inbound media (WP-30)', () => {
  it('stores a voice note as a media_asset and passes its id with the burst', async () => {
    const { businessId, owner, sim } = await setup();
    const files = new Map<string, Uint8Array>();
    const bursts: InboundBurst[] = [];
    const messaging = createMessaging({
      db,
      provider: sim,
      businessNumber: BUSINESS_NUMBER,
      handler: { handleInbound: async (b) => void bursts.push(b) },
      timers: manualTimers().timers,
      media: { put: async (path, bytes) => void files.set(path, bytes), urlFor: (path) => `https://media.postly.test/${path}` },
    });
    const voice = sim.addMedia('audio/ogg', new Uint8Array([7, 8, 9]));
    await messaging.receive({ ...sim.inboundVoice(owner, voice), providerMessageId: `SM-${randomUUID()}` });
    await messaging.flushBursts();

    const [assetId] = bursts[0]!.messages[0]!.mediaAssetIds;
    const assets = await db.withBusiness('messaging', businessId, (tx) => tx.select().from(schema.mediaAsset));
    expect(assets).toMatchObject([{ id: assetId, kind: 'voice', source: 'owner', mimeType: 'audio/ogg' }]);
    expect([...files.values()]).toEqual([new Uint8Array([7, 8, 9])]);
    expect(await messaging.mediaUrl(businessId, assetId!)).toBe(`https://media.postly.test/${assets[0]!.storagePath}`);
    const [row] = await db.withBusiness('messaging', businessId, (tx) => tx.select().from(schema.message));
    expect(row?.mediaAssetIds).toEqual([assetId]);
  });
});

describe('sweep of unprocessed messages (review queue item 14)', () => {
  it('hands a burst lost in a restart, and one whose handler failed, to the workflow again', async () => {
    const minuteAgo = new Date(Date.now() - 60_000);
    const { businessId, owner, sim } = await setup({ now: () => minuteAgo });
    const lost = createMessaging({ db, provider: sim, businessNumber: BUSINESS_NUMBER, handler: { handleInbound: async () => {} }, timers: manualTimers().timers });
    for (const text of ['יש מבצע', 'על חלות']) await lost.receive({ ...sim.inboundText(owner, text), providerMessageId: `SM-${randomUUID()}` });
    // The process stops before the quiet window ends: the burst only ever existed in memory.

    const errors: unknown[] = [];
    let failOnce = true;
    const mine: InboundBurst[] = [];
    const restarted = createMessaging({
      db,
      provider: sim,
      businessNumber: BUSINESS_NUMBER,
      timers: manualTimers().timers,
      onError: (e) => errors.push(e),
      handler: {
        handleInbound: async (b) => {
          if (b.businessId !== businessId) return;
          if (failOnce) {
            failOnce = false;
            throw new Error('workflow down');
          }
          mine.push(b);
        },
      },
    });
    await restarted.sweepUnprocessed();
    expect(errors).toHaveLength(1);
    expect(mine).toEqual([]);

    await restarted.sweepUnprocessed();
    expect(mine.map((b) => [b.from, b.text])).toEqual([[owner, 'יש מבצע\nעל חלות']]);
    await restarted.sweepUnprocessed();
    expect(mine).toHaveLength(1);
  });

  it('leaves a burst still waiting in this process alone', async () => {
    const { businessId, owner, sim } = await setup({ now: () => new Date(Date.now() - 60_000) });
    const bursts: InboundBurst[] = [];
    const handler = { handleInbound: async (b: InboundBurst) => void bursts.push(b) };
    const messaging = createMessaging({ db, provider: sim, businessNumber: BUSINESS_NUMBER, handler, timers: manualTimers().timers });
    await messaging.receive({ ...sim.inboundText(owner, 'שלום'), providerMessageId: `SM-${randomUUID()}` });
    await messaging.sweepUnprocessed();
    expect(bursts.filter((b) => b.businessId === businessId)).toEqual([]);
    await messaging.flushBursts();
    expect(bursts.filter((b) => b.businessId === businessId)).toHaveLength(1);
  });
});
