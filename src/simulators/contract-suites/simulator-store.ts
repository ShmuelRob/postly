import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MessagingSimulator } from '../messaging.js';
import { PaymentSimulator } from '../payment.js';
import { PersistentSimulator, type SimulatorStore } from '../persistent.js';
import { PublishingSimulator } from '../publishing.js';

const businessId = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const owner = '+972501234567';

/**
 * The simulated-mode store (WP-51, docs/deployment.md "Simulated mode"): two processes (web and
 * worker), each with its own simulator instances, see one outside world through the store, and a
 * restart keeps it. Runs against the in-memory store and the Postgres store (src/db).
 */
export function describeSimulatorStoreContract(label: string, makeStore: () => Promise<SimulatorStore> | SimulatorStore) {
  describe(`SimulatorStore contract: ${label}`, () => {
    /** One process's view: its own simulator objects on the shared store. */
    const processOn = (store: SimulatorStore, scope: string) => ({
      messaging: new PersistentSimulator(`${scope}:messaging`, new MessagingSimulator({ webhookSecret: 'shared-secret' }), store),
      publishing: new PersistentSimulator(`${scope}:publishing`, new PublishingSimulator(), store),
      payment: new PersistentSimulator(`${scope}:payment`, new PaymentSimulator({ webhookSecret: 'shared-secret' }), store),
    });

    it('shares what one process sent and stored with another, and keeps it across a restart', async () => {
      const store = await makeStore();
      const scope = `s-${Math.random().toString(36).slice(2)}`;
      const web = processOn(store, scope);
      const worker = processOn(store, scope);

      await web.messaging.provider.sendText({ to: owner, text: 'שלום' });
      const mediaId = await web.messaging.run((sim) => sim.addMedia('image/png', new Uint8Array([1, 2, 3])));
      await worker.messaging.provider.sendText({ to: owner, text: 'שוב שלום' });

      expect((await worker.messaging.run((sim) => sim.sentTo(owner))).map((m) => m.request)).toEqual([
        { to: owner, text: 'שלום' },
        { to: owner, text: 'שוב שלום' },
      ]);
      expect(await worker.messaging.provider.getMedia(mediaId)).toEqual({ mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) });

      const restarted = processOn(store, scope);
      expect(await restarted.messaging.run((sim) => sim.sent.length)).toBe(2);
    });

    it('serializes concurrent calls from both processes, so nothing is lost and ids stay unique', async () => {
      const store = await makeStore();
      const scope = `s-${Math.random().toString(36).slice(2)}`;
      const a = processOn(store, scope);
      const b = processOn(store, scope);
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).messaging.provider.sendText({ to: owner, text: `הודעה ${i}` })),
      );
      expect(new Set(results.map((r) => r.providerMessageId)).size).toBe(12);
      expect(await a.messaging.run((sim) => sim.sent.length)).toBe(12);
    });

    it('keeps the state a call changed even when the call throws (a lost publish response)', async () => {
      const store = await makeStore();
      const scope = `s-${Math.random().toString(36).slice(2)}`;
      const web = processOn(store, scope);
      const worker = processOn(store, scope);

      await web.publishing.provider.createConnectionLink({ businessId, networks: ['instagram'] });
      const account = await web.publishing.run((sim) => sim.connect(businessId, 'instagram'));
      await worker.publishing.run((sim) => sim.failNextPublish({ mode: 'reject_after_create' }));
      const request = {
        providerAccountId: account,
        network: 'instagram' as const,
        format: 'single' as const,
        caption: 'פוסט',
        mediaUrls: ['https://media.example.test/a.png'],
        scheduledFor: '2026-11-02T10:00:00.000Z',
        idempotencyKey: randomUUID(),
      };
      await expect(worker.publishing.provider.publish(request)).rejects.toThrow('lost response');
      // The retry finds the post the provider created.
      const { providerPostId } = await web.publishing.provider.publish(request);
      expect(await worker.publishing.run((sim) => sim.posts.map((p) => p.providerPostId))).toEqual([providerPostId]);
      expect(await worker.publishing.provider.getPublicationStatus(providerPostId)).toEqual({
        status: 'published',
        publishedAt: request.scheduledFor,
      });
    });

    it('lets the sandbox complete a payment that web created, with a callback web verifies', async () => {
      const store = await makeStore();
      const scope = `s-${Math.random().toString(36).slice(2)}`;
      const web = processOn(store, scope);
      const sandbox = processOn(store, scope);

      const link = await web.payment.provider.createPaymentLink({ businessId, plan: 'basic', price: { amountAgorot: 30000, currency: 'ILS' } });
      const subscriptionId = await sandbox.payment.run((sim) => sim.completePayment(link.providerCustomerId));
      const hook = await sandbox.payment.run((sim) => sim.webhook(subscriptionId));
      expect(await web.payment.provider.verifyWebhook(hook)).toMatchObject({ businessId, providerSubscriptionId: subscriptionId, status: 'active' });
      expect(await web.payment.provider.getSubscriptionStatus(subscriptionId)).toEqual({ status: 'active' });
    });

    it('stores files for every process', async () => {
      const store = await makeStore();
      const path = `s-${Math.random().toString(36).slice(2)}/posts/a.png`;
      await store.putFile(path, new Uint8Array([9, 8, 7]), 'image/png');
      expect(await store.getFile(path)).toEqual({ mimeType: 'image/png', data: new Uint8Array([9, 8, 7]) });
      expect(await store.getFile(`${path}.missing`)).toBeUndefined();
      await store.removeFiles({ prefix: path.split('/')[0]! });
      expect(await store.getFile(path)).toBeUndefined();
    });
  });
}
