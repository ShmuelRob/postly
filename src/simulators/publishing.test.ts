import { describe, expect, it } from 'vitest';
import type { PublishRequest } from '../contracts/providers/publishing.js';
import { describePublishingProviderContract } from './contract-suites/publishing.js';
import { PublishingSimulator } from './publishing.js';

const businessId = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

describePublishingProviderContract('simulator', () => {
  const provider = new PublishingSimulator();
  const providerAccountId = provider.connect(businessId, 'instagram');
  return {
    provider,
    businessId,
    connected: { network: 'instagram', providerAccountId },
    mediaUrl: 'https://storage.example.test/a.jpg',
  };
});

describe('PublishingSimulator', () => {
  let clock = new Date('2026-11-02T10:00:00.000Z');
  const make = () => {
    clock = new Date('2026-11-02T10:00:00.000Z');
    const sim = new PublishingSimulator({ now: () => clock });
    const account = sim.connect(businessId, 'facebook');
    const request = (over: Partial<PublishRequest> = {}): PublishRequest => ({
      idempotencyKey: crypto.randomUUID(),
      providerAccountId: account,
      network: 'facebook',
      caption: 'מבצע 20% על תמרים',
      mediaUrls: ['https://storage.example.test/a.jpg'],
      format: 'single',
      scheduledFor: '2026-11-03T08:00:00.000Z',
      ...over,
    });
    return { sim, account, request };
  };

  it('tracks connection status from link to connect to disconnect', async () => {
    const sim = new PublishingSimulator();
    const status = () => sim.getConnectionStatus({ businessId, network: 'instagram' });
    expect(await status()).toEqual({ status: 'disconnected' });
    await sim.createConnectionLink({ businessId, networks: ['instagram'] });
    expect(await status()).toEqual({ status: 'pending' });
    const account = sim.connect(businessId, 'instagram');
    expect(await status()).toEqual({ status: 'connected', providerAccountId: account });
    sim.disconnect(account);
    expect(await status()).toEqual({ status: 'disconnected', providerAccountId: account });
    expect(sim.connectionLinks).toHaveLength(1);
  });

  it('records what reached each network, once per idempotency key', async () => {
    const { sim, request } = make();
    const req = request();
    await sim.publish(req);
    await sim.publish(req);
    expect(sim.postsOn('facebook').map((p) => p.request)).toEqual([req]);
    expect(sim.postsOn('instagram')).toEqual([]);
  });

  it('is scheduled until its time, then published', async () => {
    const { sim, request } = make();
    const { providerPostId } = await sim.publish(request());
    expect(await sim.getPublicationStatus(providerPostId)).toEqual({ status: 'scheduled' });
    clock = new Date('2026-11-03T09:00:00.000Z');
    expect(await sim.getPublicationStatus(providerPostId)).toEqual({
      status: 'published',
      publishedAt: '2026-11-03T08:00:00.000Z',
    });
    expect(sim.publishedOn('facebook')).toHaveLength(1);
  });

  it('rejects publishing to an account that is not connected', async () => {
    const { sim, account, request } = make();
    sim.disconnect(account);
    await expect(sim.publish(request())).rejects.toThrow(/not connected/);
    expect(sim.posts).toEqual([]);
  });

  it('scripts a rejected call that creates nothing', async () => {
    const { sim, request } = make();
    sim.failNextPublish({ mode: 'reject', error: 'rate limited' });
    await expect(sim.publish(request())).rejects.toThrow('rate limited');
    expect(sim.posts).toEqual([]);
  });

  it('scripts a lost response after the post was created, so a retry finds it', async () => {
    const { sim, request } = make();
    const req = request();
    sim.failNextPublish({ mode: 'reject_after_create', error: 'timeout' });
    await expect(sim.publish(req)).rejects.toThrow('timeout');
    expect(sim.posts).toHaveLength(1);
    const retry = await sim.publish(req);
    expect(retry.providerPostId).toBe(sim.posts[0]?.providerPostId);
    expect(sim.posts).toHaveLength(1);
  });

  it('scripts a post that the network fails later', async () => {
    const { sim, request } = make();
    sim.failNextPublish({ mode: 'fail_status', error: 'media rejected' });
    const { providerPostId } = await sim.publish(request());
    expect(await sim.getPublicationStatus(providerPostId)).toEqual({ status: 'failed', error: 'media rejected' });
    expect(sim.publishedOn('facebook')).toEqual([]);
  });

  it('returns scripted metrics for posts in the window', async () => {
    const { sim, account, request } = make();
    const { providerPostId } = await sim.publish(request());
    sim.setMetrics(providerPostId, { reach: 120, likes: 8 });
    clock = new Date('2026-11-03T09:00:00.000Z');
    const window = { providerAccountId: account, from: '2026-11-01T00:00:00.000Z', to: '2026-11-04T00:00:00.000Z' };
    expect(await sim.getMetrics(window)).toEqual([{ providerPostId, reach: 120, likes: 8 }]);
    expect(await sim.getMetrics({ ...window, to: '2026-11-02T00:00:00.000Z' })).toEqual([]);
  });
});
