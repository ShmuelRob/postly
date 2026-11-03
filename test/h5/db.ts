/**
 * Test-owned database reads and writes for the H5 tests. Every observation the tests assert on, and
 * every state they force (pauses, handoff, forged rows), goes through these fixed queries, never
 * through code the implementing session wrote. They run as app_system (RLS bypassed) because they
 * look across businesses.
 */
import { sql } from 'drizzle-orm';
import { inject } from 'vitest';
import { createDatabase, type Database } from '../../src/db/index.js';
import type { Network } from '../../src/contracts/common.js';

export interface H5Db {
  readonly db: Database;
  postStatus(postId: string): Promise<string | undefined>;
  approvals(postId: string): Promise<{ approvalId: string; versionHash: string; invalidated: boolean; approverPhone: string }[]>;
  publication(publicationId: string): Promise<{ status: string; providerPostId: string | null; attempts: number } | undefined>;
  publicationCount(): Promise<number>;
  setGlobalPause(paused: boolean): Promise<void>;
  setBusinessPaused(businessId: string, paused: boolean): Promise<void>;
  setHandoff(businessId: string, on: boolean): Promise<void>;
  /** Inserts a publication directly, the way a bug or tampering would. May throw if the database refuses it. */
  forgePublication(row: {
    businessId: string;
    postId: string;
    approvalId: string;
    approvedVersionHash: string;
    network: Network;
    scheduledFor: string;
  }): Promise<string>;
  /** Simulates a crash after the provider accepted the post: the row holds its provider id and waits for a retry. */
  markRetryPending(publicationId: string, providerPostId: string): Promise<void>;
  close(): Promise<void>;
}

type Row = Record<string, unknown>;

export function openH5Db(): H5Db {
  const db = createDatabase(inject('databaseUrls'), { max: 2 });
  const rows = (query: ReturnType<typeof sql>) =>
    db.withSystem('console', async (tx) => (await tx.execute(query)) as unknown as Row[]);

  return {
    db,
    async postStatus(postId) {
      const [row] = await rows(sql`select status from post where id = ${postId}`);
      return row?.status as string | undefined;
    },
    async approvals(postId) {
      const result = await rows(
        sql`select id, approved_version_hash, invalidated_at, approver_phone from approval where post_id = ${postId} order by approved_at`,
      );
      return result.map((r) => ({
        approvalId: r.id as string,
        versionHash: r.approved_version_hash as string,
        invalidated: r.invalidated_at !== null,
        approverPhone: r.approver_phone as string,
      }));
    },
    async publication(publicationId) {
      const [row] = await rows(sql`select status, provider_post_id, attempts from publication where id = ${publicationId}`);
      return row && { status: row.status as string, providerPostId: row.provider_post_id as string | null, attempts: Number(row.attempts) };
    },
    async publicationCount() {
      const [row] = await rows(sql`select count(*)::int as n from publication`);
      return Number(row?.n);
    },
    async setGlobalPause(paused) {
      await rows(
        sql`insert into system_control (id, publishing_paused) values (1, ${paused}) on conflict (id) do update set publishing_paused = ${paused}`,
      );
    },
    async setBusinessPaused(businessId, paused) {
      await rows(sql`update business set status = ${paused ? 'paused' : 'active'} where id = ${businessId}`);
    },
    async setHandoff(businessId, on) {
      await rows(
        sql`insert into conversation_state (business_id, handoff_at) values (${businessId}, ${on ? sql`now()` : null})
            on conflict (business_id) do update set handoff_at = excluded.handoff_at`,
      );
    },
    async forgePublication(row) {
      const [inserted] = await rows(sql`
        insert into publication (business_id, post_id, approval_id, approved_version_hash, channel_connection_id, network, scheduled_for)
        select ${row.businessId}, ${row.postId}, ${row.approvalId}, ${row.approvedVersionHash}, c.id, ${row.network}, ${row.scheduledFor}
        from channel_connection c where c.business_id = ${row.businessId} and c.network = ${row.network}
        returning id`);
      if (!inserted) throw new Error('forgePublication: the business has no channel connection on that network');
      return inserted.id as string;
    },
    async markRetryPending(publicationId, providerPostId) {
      await rows(
        sql`update publication set status = 'retry_pending', provider_post_id = ${providerPostId}, attempts = 1 where id = ${publicationId}`,
      );
    },
    close: () => db.close(),
  };
}
