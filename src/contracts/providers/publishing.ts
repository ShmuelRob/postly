import { z } from 'zod';
import { Network, PostFormat, Timestamp, Url, Uuid } from '../common.js';

export const CreateConnectionLinkRequest = z.object({ businessId: Uuid, networks: z.array(Network).min(1) });
export type CreateConnectionLinkRequest = z.infer<typeof CreateConnectionLinkRequest>;

export const ConnectionLink = z.object({ url: Url, expiresAt: Timestamp });
export type ConnectionLink = z.infer<typeof ConnectionLink>;

export const ConnectionStatusRequest = z.object({ businessId: Uuid, network: Network });
export type ConnectionStatusRequest = z.infer<typeof ConnectionStatusRequest>;

export const ConnectionStatus = z.object({
  status: z.enum(['pending', 'connected', 'disconnected']),
  providerAccountId: z.string().min(1).optional(),
});
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const PublishRequest = z.object({
  /** The publication id, so a retried call never creates a second post. */
  idempotencyKey: Uuid,
  providerAccountId: z.string().min(1),
  network: Network,
  caption: z.string().min(1),
  mediaUrls: z.array(Url).min(1).max(10),
  format: PostFormat,
  scheduledFor: Timestamp,
});
export type PublishRequest = z.infer<typeof PublishRequest>;

export const PublishResult = z.object({ providerPostId: z.string().min(1) });
export type PublishResult = z.infer<typeof PublishResult>;

export const PublicationStatus = z.object({
  status: z.enum(['scheduled', 'published', 'failed']),
  error: z.string().optional(),
  publishedAt: Timestamp.optional(),
});
export type PublicationStatus = z.infer<typeof PublicationStatus>;

export const MetricsRequest = z.object({ providerAccountId: z.string().min(1), from: Timestamp, to: Timestamp });
export type MetricsRequest = z.infer<typeof MetricsRequest>;

const count = z.int().min(0).optional();
export const PostMetrics = z.array(
  z.object({ providerPostId: z.string().min(1), reach: count, likes: count, comments: count, shares: count }),
);
export type PostMetrics = z.infer<typeof PostMetrics>;

/** The only code that knows the unified social API implements this. */
export interface PublishingProvider {
  readonly name: string;
  createConnectionLink(request: CreateConnectionLinkRequest): Promise<ConnectionLink>;
  getConnectionStatus(request: ConnectionStatusRequest): Promise<ConnectionStatus>;
  publish(request: PublishRequest): Promise<PublishResult>;
  getPublicationStatus(providerPostId: string): Promise<PublicationStatus>;
  getMetrics(request: MetricsRequest): Promise<PostMetrics>;
}
