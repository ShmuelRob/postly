import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { WindowClosedError } from '../../contracts/providers/messaging.js';
import { createDatabase } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { buildServer } from '../../server.js';
import { MessagingSimulator } from '../../simulators/messaging.js';
import { createMessaging, type InboundBurst, type Messaging, type Timers, WEBHOOK_PATH } from './index.js';

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
  /** Runs every due timer once and forgets it, as a real timer would. */
  const fire = () => {
    const fns = [...due.values()];
    due.clear();
    fns.forEach((fn) => fn());
  };
  return { timers, fire, pending: () => due.size };
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
    let t = Date.now();
    const { owner, sim, bursts, clock, messaging } = await setup({ now: () => new Date(t) });
    await messaging.receive(sim.inboundText(owner, 'יש מבצע'));
    await messaging.receive(sim.inboundImage(owner, 'ME-1', 'חלות'));
    await messaging.receive(sim.inboundText(owner, '2 ב-20'));
    expect(bursts).toHaveLength(0);
    // One wake-up per sender, however many messages (the job's singletonKey).
    expect(clock.pending()).toBe(1);
    t += 20_000;
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

  it('skips an unreadable row and still hands the other bursts over', async () => {
    const { businessId, owner, sim } = await setup({ now: () => new Date(Date.now() - 60_000) });
    const other = await setup();
    // An inbound row with no payload, as another writer could leave it.
    await db.withBusiness('messaging', other.businessId, (tx) =>
      tx.insert(schema.message).values({
        id: randomUUID(),
        businessId: other.businessId,
        direction: 'inbound',
        kind: 'text',
        provider: 'sim',
        providerMessageId: `SM-${randomUUID()}`,
        fromPhone: other.owner,
        toPhone: BUSINESS_NUMBER,
        createdAt: new Date(Date.now() - 60_000),
      }),
    );
    const lost = createMessaging({ db, provider: sim, businessNumber: BUSINESS_NUMBER, handler: { handleInbound: async () => {} }, timers: manualTimers().timers });
    await lost.receive({ ...sim.inboundText(owner, 'שלום'), providerMessageId: `SM-${randomUUID()}` });
    const mine: InboundBurst[] = [];
    const restarted = createMessaging({
      db,
      provider: sim,
      businessNumber: BUSINESS_NUMBER,
      timers: manualTimers().timers,
      handler: { handleInbound: async (b) => void (b.businessId === businessId && mine.push(b)) },
    });
    await restarted.sweepUnprocessed();
    expect(mine.map((b) => b.text)).toEqual(['שלום']);
  });

  it('leaves a burst still inside its quiet window alone', async () => {
    const { businessId, owner, sim } = await setup();
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

describe('sweep while a burst is being delivered', () => {
  it('does not hand a burst over again while its delivery is still running', async () => {
    const { businessId, owner, sim } = await setup({ now: () => new Date(Date.now() - 60_000) });
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const handled: InboundBurst[] = [];
    const messaging = createMessaging({
      db,
      provider: sim,
      businessNumber: BUSINESS_NUMBER,
      timers: manualTimers().timers,
      handler: {
        handleInbound: async (b) => {
          if (b.businessId !== businessId) return;
          handled.push(b);
          await gate;
        },
      },
    });
    await messaging.receive({ ...sim.inboundText(owner, 'שלום'), providerMessageId: `SM-${randomUUID()}` });
    const flushing = messaging.flushBursts();
    await expect.poll(() => handled.length).toBe(1);
    await messaging.sweepUnprocessed({ businessId });
    release();
    await flushing;
    await messaging.sweepUnprocessed({ businessId });
    expect(handled).toHaveLength(1);
  });
});

describe('durable bursts across instances (T2, review queue items 13, 14, 24)', () => {
  /** Two messaging instances on one database, as two web instances are, on one clock. */
  async function twoInstances(handle: (b: InboundBurst) => Promise<void> = async () => {}) {
    let t = Date.now();
    const now = () => new Date(t);
    const { businessId, owner, sim } = await setup({ now });
    const handled: InboundBurst[] = [];
    const errors: unknown[] = [];
    const instance = () => {
      const clock = manualTimers();
      const messaging = createMessaging({
        db,
        provider: sim,
        businessNumber: BUSINESS_NUMBER,
        timers: clock.timers,
        now,
        onError: (e) => errors.push(e),
        handler: {
          handleInbound: async (b) => {
            if (b.businessId !== businessId) return;
            handled.push(b);
            await handle(b);
          },
        },
      });
      return { clock, messaging };
    };
    const send = (m: Pick<Messaging, 'receive'>, text: string) => m.receive({ ...sim.inboundText(owner, text), providerMessageId: `SM-${randomUUID()}` });
    return { businessId, owner, a: instance(), b: instance(), handled, errors, send, now, advance: (ms: number) => void (t += ms) };
  }
  const slow = () => new Promise<void>((r) => setTimeout(r, 20));

  it('hands one burst received by two instances over exactly once, with every message', async () => {
    const { a, b, handled, send, advance } = await twoInstances(slow);
    await send(a.messaging, 'יש מבצע');
    await send(b.messaging, 'על חלות');
    await send(a.messaging, '2 ב-20');
    advance(20_000);
    a.clock.fire();
    b.clock.fire();
    await expect.poll(() => handled.length).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(handled).toHaveLength(1);
    expect(handled[0]?.text).toBe('יש מבצע\nעל חלות\n2 ב-20');
  });

  it('two concurrent claims for the same sender hand the burst over once', async () => {
    const { businessId, owner, a, b, handled, send, advance } = await twoInstances(slow);
    await send(a.messaging, 'שלום');
    await send(b.messaging, 'מה נשמע');
    advance(20_000);
    const counts = await Promise.all([a.messaging.processBurst(businessId, owner), b.messaging.processBurst(businessId, owner)]);
    expect(handled).toHaveLength(1);
    expect(counts.sort()).toEqual([0, 2]);
    const rows = await db.withBusiness('messaging', businessId, (tx) => tx.select().from(schema.message));
    expect(rows.every((r) => r.processedAt !== null && r.claimedAt !== null)).toBe(true);
  });

  it('waits until the newest message of the burst is quiet, on whichever instance wakes', async () => {
    const { a, b, handled, send, advance } = await twoInstances();
    await send(a.messaging, 'יש מבצע');
    advance(15_000);
    await send(b.messaging, 'על חלות');
    advance(6_000);
    a.clock.fire();
    // The early wake-up asked for another one at the newest message plus the quiet window.
    await expect.poll(() => a.clock.pending()).toBe(1);
    expect(handled).toHaveLength(0);
    advance(15_000);
    a.clock.fire();
    await expect.poll(() => handled.length).toBe(1);
    expect(handled[0]?.messages).toHaveLength(2);
  });

  it('takes a claim again only once it is older than 5 minutes', async () => {
    const { businessId, a, handled, send, advance, now } = await twoInstances();
    await send(a.messaging, 'שלום');
    advance(60_000);
    // A process claimed the message and died before handing it over.
    const claim = (at: Date) =>
      db.withBusiness('messaging', businessId, (tx) => tx.update(schema.message).set({ claimedAt: at }).where(eq(schema.message.businessId, businessId)));
    await claim(new Date(now().getTime() - 60_000));
    await a.messaging.sweepUnprocessed({ businessId });
    expect(handled).toHaveLength(0);
    await claim(new Date(now().getTime() - 6 * 60_000));
    await a.messaging.sweepUnprocessed({ businessId });
    expect(handled).toHaveLength(1);
  });

  it('a handler that throws releases its claim, so the sweep hands the burst over again', async () => {
    let fail = true;
    const { businessId, a, handled, errors, send, advance } = await twoInstances(async () => {
      if (!fail) return;
      fail = false;
      throw new Error('workflow down');
    });
    await send(a.messaging, 'שלום');
    advance(20_000);
    a.clock.fire();
    await expect.poll(() => errors.length).toBe(1);
    const [row] = await db.withBusiness('messaging', businessId, (tx) => tx.select().from(schema.message));
    expect(row).toMatchObject({ processedAt: null, claimedAt: null });
    advance(1_000);
    await a.messaging.sweepUnprocessed({ businessId });
    expect(handled).toHaveLength(2);
  });
});
