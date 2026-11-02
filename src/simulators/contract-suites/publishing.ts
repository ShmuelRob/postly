import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Network } from '../../contracts/common.js';
import {
  ConnectionLink,
  ConnectionStatus,
  PostMetrics,
  PublicationStatus,
  type PublishingProvider,
  type PublishRequest,
  PublishResult,
} from '../../contracts/providers/publishing.js';

export interface PublishingContractContext {
  provider: PublishingProvider;
  businessId: string;
  /** An account already connected for this business on this network. */
  connected: { network: Network; providerAccountId: string };
  /** A media url the provider can fetch. */
  mediaUrl: string;
}

/** The behavior every PublishingProvider must share; WP-41 runs it against the real adapter. */
export function describePublishingProviderContract(
  label: string,
  makeContext: () => PublishingContractContext | Promise<PublishingContractContext>,
): void {
  describe(`PublishingProvider contract: ${label}`, () => {
    let ctx: PublishingContractContext;
    beforeEach(async () => {
      ctx = await makeContext();
    });

    const publishRequest = (): PublishRequest => ({
      idempotencyKey: randomUUID(),
      providerAccountId: ctx.connected.providerAccountId,
      network: ctx.connected.network,
      caption: 'צבעונים חדשים הגיעו לחנות',
      mediaUrls: [ctx.mediaUrl],
      format: 'single',
      scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    it('has a name', () => {
      expect(ctx.provider.name.length).toBeGreaterThan(0);
    });

    it('creates a connection link', async () => {
      const link = await ctx.provider.createConnectionLink({ businessId: ctx.businessId, networks: ['instagram'] });
      expect(ConnectionLink.safeParse(link).success).toBe(true);
    });

    it('reports a connected account with its provider account id', async () => {
      const status = await ctx.provider.getConnectionStatus({
        businessId: ctx.businessId,
        network: ctx.connected.network,
      });
      expect(ConnectionStatus.parse(status)).toEqual({
        status: 'connected',
        providerAccountId: ctx.connected.providerAccountId,
      });
    });

    it('publishes and reports the publication status', async () => {
      const result = await ctx.provider.publish(publishRequest());
      expect(PublishResult.safeParse(result).success).toBe(true);
      const status = await ctx.provider.getPublicationStatus(result.providerPostId);
      expect(PublicationStatus.safeParse(status).success).toBe(true);
    });

    it('never creates a second post for a retried idempotency key', async () => {
      const request = publishRequest();
      const first = await ctx.provider.publish(request);
      const retry = await ctx.provider.publish(request);
      expect(retry.providerPostId).toBe(first.providerPostId);
    });

    it('gives different publications different post ids', async () => {
      const a = await ctx.provider.publish(publishRequest());
      const b = await ctx.provider.publish(publishRequest());
      expect(a.providerPostId).not.toBe(b.providerPostId);
    });

    it('rejects a request outside the contract shape', async () => {
      await expect(ctx.provider.publish({ ...publishRequest(), mediaUrls: [] })).rejects.toThrow();
      await expect(ctx.provider.publish({ ...publishRequest(), idempotencyKey: 'retry-1' })).rejects.toThrow();
    });

    it('rejects an unknown provider post id', async () => {
      await expect(ctx.provider.getPublicationStatus('no-such-post')).rejects.toThrow();
    });

    it('returns metrics in the contract shape', async () => {
      const now = Date.now();
      const metrics = await ctx.provider.getMetrics({
        providerAccountId: ctx.connected.providerAccountId,
        from: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
        to: new Date(now).toISOString(),
      });
      expect(PostMetrics.safeParse(metrics).success).toBe(true);
    });
  });
}
