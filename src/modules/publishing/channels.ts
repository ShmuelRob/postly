import { and, eq } from 'drizzle-orm';
import type { Network } from '../../contracts/common.js';
import type { PublishingProvider } from '../../contracts/providers/publishing.js';
import type { Database, Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';

/** The workflow's `apply`, for the channel connection machine (publishing does not import workflow). */
export type ApplyChannelEvent = (
  businessId: string,
  request: {
    machine: 'channel_connection';
    id: string;
    event: 'CONNECTED' | 'TEST_PASSED' | 'TEST_FAILED' | 'HEALTH_CHECK_FAILED' | 'REVOKED';
    source: 'system';
    guard?: (tx: Tx, current: { from: string; to: string }) => Promise<string | null>;
  },
) => Promise<{ ok: boolean }>;

export interface ChannelStatus {
  network: Network;
  status: 'pending' | 'connected' | 'verified' | 'disconnected' | 'revoked';
}

export interface Channels {
  /** Creates a `pending` connection per network (once) and returns the provider's connection link. */
  requestLink(businessId: string, networks: Network[]): Promise<string>;
  /**
   * Asks the provider about every pending or connected channel: a linked account becomes
   * `connected`, and the test (the provider's `testSchedule` confirms a post can be scheduled on the
   * account; nothing is published, state-machines.md, Onboarding) makes it `verified`. A failed test
   * applies `TEST_FAILED`, so the channel is `pending` again and the owner gets the link again.
   */
  checkAndTest(businessId: string): Promise<ChannelStatus[]>;
  /**
   * The daily health check (technical-design.md, Failure handling): asks the provider about every
   * `verified` channel. Still connected with the same account sets `last_health_check_at`; anything
   * else applies `HEALTH_CHECK_FAILED` and opens a `channel_disconnected` console item. Returns the
   * networks that were disconnected now, for the owner's template.
   */
  healthCheck(businessId: string): Promise<Network[]>;
  /**
   * Cancellation (WP-43; technical-design.md, Cancellation): disconnects every channel that is not
   * `revoked` at the provider and applies `REVOKED` at once. A provider error does not stop the
   * revoke; it opens a `channel_disconnected` console item (reason `cancellation`) for the team.
   * Returns the networks revoked now and those whose provider disconnect failed.
   */
  revokeAll(businessId: string): Promise<{ revoked: Network[]; providerFailed: Network[] }>;
}

export function createChannels(deps: { db: Database; provider: PublishingProvider; apply: ApplyChannelEvent; now?: () => Date }): Channels {
  const { db, provider } = deps;
  const now = deps.now ?? (() => new Date());
  const t = schema.channelConnection;
  const rows = (businessId: string) => db.withBusiness('publishing', businessId, (tx) => tx.select().from(t).where(eq(t.businessId, businessId)));

  return {
    async requestLink(businessId, networks) {
      await db.withBusiness('publishing', businessId, async (tx) => {
        for (const network of networks) {
          await tx.insert(t).values({ businessId, network, provider: provider.name }).onConflictDoNothing({ target: [t.businessId, t.network] });
        }
      });
      const link = await provider.createConnectionLink({ businessId, networks });
      return link.url;
    },

    async checkAndTest(businessId) {
      for (const row of await rows(businessId)) {
        if (row.status !== 'pending' && row.status !== 'connected') continue;
        const status = await provider.getConnectionStatus({ businessId, network: row.network });
        const accountId = status.status === 'connected' ? status.providerAccountId : undefined;
        if (!accountId) continue;
        if (row.status === 'pending') {
          await deps.apply(businessId, {
            machine: 'channel_connection',
            id: row.id,
            event: 'CONNECTED',
            source: 'system',
            guard: async (tx) => {
              await tx.update(t).set({ providerAccountId: accountId }).where(and(eq(t.id, row.id), eq(t.businessId, businessId)));
              return null;
            },
          });
        }
        const test = await provider.testSchedule({ providerAccountId: accountId, network: row.network });
        if (!test.ok) {
          await deps.apply(businessId, { machine: 'channel_connection', id: row.id, event: 'TEST_FAILED', source: 'system' });
          continue;
        }
        await deps.apply(businessId, {
          machine: 'channel_connection',
          id: row.id,
          event: 'TEST_PASSED',
          source: 'system',
          guard: async (tx) => {
            await tx.update(t).set({ verifiedAt: now(), lastHealthCheckAt: now() }).where(eq(t.id, row.id));
            return null;
          },
        });
      }
      return (await rows(businessId)).map((r) => ({ network: r.network, status: r.status }));
    },

    async healthCheck(businessId) {
      const lost: Network[] = [];
      for (const row of await rows(businessId)) {
        if (row.status !== 'verified') continue;
        const status = await provider.getConnectionStatus({ businessId, network: row.network });
        if (status.status === 'connected' && status.providerAccountId === row.providerAccountId) {
          await db.withBusiness('publishing', businessId, (tx) => tx.update(t).set({ lastHealthCheckAt: now() }).where(eq(t.id, row.id)));
          continue;
        }
        const result = await deps.apply(businessId, {
          machine: 'channel_connection',
          id: row.id,
          event: 'HEALTH_CHECK_FAILED',
          source: 'system',
          guard: async (tx) => {
            await tx.update(t).set({ lastHealthCheckAt: now() }).where(eq(t.id, row.id));
            await tx.insert(schema.consoleItem).values({
              businessId,
              kind: 'channel_disconnected',
              referenceId: row.id,
              details: { network: row.network, providerStatus: status.status, reason: 'daily health check' },
            });
            return null;
          },
        });
        if (result.ok) lost.push(row.network);
      }
      return lost;
    },

    async revokeAll(businessId) {
      const revoked: Network[] = [];
      const providerFailed: Network[] = [];
      for (const row of await rows(businessId)) {
        if (row.status === 'revoked') continue;
        let providerError: string | undefined;
        if (row.providerAccountId) {
          try {
            await provider.disconnectAccount({ providerAccountId: row.providerAccountId, network: row.network });
          } catch (error) {
            providerError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
          }
        }
        const result = await deps.apply(businessId, {
          machine: 'channel_connection',
          id: row.id,
          event: 'REVOKED',
          source: 'system',
          guard: async (tx) => {
            if (providerError !== undefined) {
              await tx.insert(schema.consoleItem).values({
                businessId,
                kind: 'channel_disconnected',
                referenceId: row.id,
                details: { network: row.network, reason: 'cancellation', error: providerError },
              });
            }
            return null;
          },
        });
        if (result.ok) revoked.push(row.network);
        if (providerError !== undefined) providerFailed.push(row.network);
      }
      return { revoked, providerFailed };
    },
  };
}
