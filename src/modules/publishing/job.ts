import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { PublishDeferral, PublishingJob, PublishOutcome, PublishRefusal } from '../../contracts/approval.js';
import { NETWORKS, type Network } from '../../contracts/common.js';
import type { PublishingProvider } from '../../contracts/providers/publishing.js';
import type { Database, Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { log } from '../../shared/logger.js';
import { metrics, withSpan } from '../../shared/telemetry.js';

// The publishing job (state-machines.md, Publishing guard and Publication; technical-design.md,
// Scheduling and publishing flow). Code only: a publication reaches the provider only when it is tied
// to a valid approval of its post's current version, with no pause and no handoff.

/** The workflow's `apply`, for the publication and post machines (publishing does not import workflow). */
export type ApplyPublishingEvent = (
  businessId: string,
  request: {
    machine: 'publication' | 'post';
    id: string;
    event: string;
    source: 'system';
    role: 'publishing';
    guard?: (tx: Tx, current: { from: string; to: string }) => Promise<string | null>;
  },
) => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;

/** What the owner is told when a post's publications are all done (a template; the window has usually closed). */
export type PublishingNotice =
  | { kind: 'published'; postId: string; networks: Network[] }
  | { kind: 'failed'; postId: string; published: Network[]; failed: Network[] };

export interface PublishingJobDeps {
  db: Database;
  provider: PublishingProvider;
  apply: ApplyPublishingEvent;
  /** False while a person handles the conversation (the publishing role cannot read conversation_state). */
  mayAutoReply(businessId: string): Promise<boolean>;
  /** The URL the provider fetches a stored file from. */
  urlFor(storagePath: string): string;
  /** Sends the owner the confirmation or failure template. Its failure is logged, never retried here. */
  notify(businessId: string, notice: PublishingNotice): Promise<void>;
  now?: () => Date;
}

export interface Publishing extends PublishingJob {
  /**
   * The worker's tick: runs every publication that is due at `now`. `businessId` limits it to one
   * business (the playground and tests, which share a database with other businesses).
   */
  tick(now: Date, options?: { businessId?: string }): Promise<{ ran: number }>;
}

/** Three attempts in all (Configuration defaults). */
export const MAX_ATTEMPTS = 3;
/** Wait before the second and the third attempt. */
export const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000];
/** An `in_progress` publication not updated for this long belongs to a run that crashed. */
export const STALE_MS = 10 * 60_000;

const REFUSALS: readonly string[] = ['not_approved', 'not_current_version', 'cross_business'] satisfies PublishRefusal[];
const DEFERRALS: readonly string[] = ['global_pause', 'business_pause', 'handoff'] satisfies PublishDeferral[];

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

export function createPublishingJob(deps: PublishingJobDeps): Publishing {
  const { db, provider } = deps;
  const now = deps.now ?? (() => new Date());
  const p = schema.publication;

  const businessOf = async (publicationId: string) => {
    const [row] = await db.withSystem('scheduler', (tx) => tx.select({ businessId: p.businessId }).from(p).where(eq(p.id, publicationId)));
    return row?.businessId;
  };

  /** The publishing guard, run inside the transaction that locks the publication and applies STARTED. */
  async function guard(tx: Tx, publicationId: string, handoff: boolean): Promise<string | null> {
    const [pub] = await tx.select().from(p).where(eq(p.id, publicationId));
    if (!pub) return 'cross_business';
    // RLS shows only this business's rows, so another business's approval is not found here.
    const [approval] = await tx.select().from(schema.approval).where(eq(schema.approval.id, pub.approvalId));
    if (!approval || approval.businessId !== pub.businessId) return 'cross_business';
    if (approval.invalidatedAt !== null || approval.approvedVersionHash !== pub.approvedVersionHash) return 'not_approved';
    const [post] = await tx.select({ currentVersionId: schema.post.currentVersionId }).from(schema.post).where(eq(schema.post.id, pub.postId));
    if (!post || approval.postId !== pub.postId || post.currentVersionId !== approval.postVersionId) return 'not_current_version';
    const [current] = await tx.select({ hash: schema.postVersion.contentHash }).from(schema.postVersion).where(eq(schema.postVersion.id, post.currentVersionId));
    if (current?.hash !== pub.approvedVersionHash) return 'not_current_version';
    // Deferrals come after every refusal, and are read right before the provider call.
    const [control] = await tx.select({ paused: schema.systemControl.publishingPaused }).from(schema.systemControl);
    if (control?.paused) return 'global_pause';
    const [business] = await tx.select({ status: schema.business.status }).from(schema.business).where(eq(schema.business.id, pub.businessId));
    if (business?.status !== 'active') return 'business_pause';
    if (handoff) return 'handoff';
    await tx.update(p).set({ attempts: sql`${p.attempts} + 1` }).where(eq(p.id, publicationId));
    return null;
  }

  /** Everything the provider call needs, from the approved version (read after STARTED). */
  async function load(businessId: string, publicationId: string) {
    return db.withBusiness('publishing', businessId, async (tx) => {
      const [pub] = await tx.select().from(p).where(eq(p.id, publicationId));
      if (!pub) throw new Error(`publication ${publicationId} disappeared`);
      const [approval] = await tx.select().from(schema.approval).where(eq(schema.approval.id, pub.approvalId));
      const [version] = await tx.select().from(schema.postVersion).where(eq(schema.postVersion.id, approval!.postVersionId));
      const [channel] = await tx.select().from(schema.channelConnection).where(eq(schema.channelConnection.id, pub.channelConnectionId));
      const [post] = await tx.select({ format: schema.post.format }).from(schema.post).where(eq(schema.post.id, pub.postId));
      const captions = version!.captions as Partial<Record<Network, { text: string; hashtags: string[] }>>;
      const caption = captions[pub.network];
      const assetIds = (version!.renderedMedia as Partial<Record<Network, string[]>>)[pub.network] ?? [];
      const assets = assetIds.length ? await tx.select().from(schema.mediaAsset).where(inArray(schema.mediaAsset.id, assetIds)) : [];
      const mediaUrls = assetIds.map((id) => assets.find((a) => a.id === id)).filter((a) => a !== undefined).map((a) => deps.urlFor(a.storagePath));
      if (!caption || mediaUrls.length === 0 || !channel?.providerAccountId) throw new Error(`publication ${publicationId}: the approved version has no caption, media or account for ${pub.network}`);
      return {
        pub,
        request: {
          idempotencyKey: pub.id,
          providerAccountId: channel.providerAccountId,
          network: pub.network,
          caption: caption.hashtags.length ? `${caption.text}\n${caption.hashtags.join(' ')}` : caption.text,
          mediaUrls,
          format: post!.format,
          scheduledFor: pub.scheduledFor.toISOString(),
        },
      };
    });
  }

  const event = (businessId: string, machine: 'publication' | 'post', id: string, name: string, g?: (tx: Tx) => Promise<string | null>) =>
    deps.apply(businessId, { machine, id, event: name, source: 'system', role: 'publishing', ...(g ? { guard: g } : {}) });

  /** The provider id, in its own write as soon as `publish` returns, so a later error leaves a retry that checks the provider first. */
  const storeProviderId = (businessId: string, publicationId: string, providerPostId: string | null) =>
    db.withBusiness('publishing', businessId, (tx) => tx.update(p).set({ providerPostId }).where(eq(p.id, publicationId)));

  /**
   * One open `publication_failed` item per publication (review of PR #52, item b): the publication row
   * is locked first, so sibling publications finishing in parallel cannot both insert one.
   */
  async function openFailedItem(tx: Tx, businessId: string, publicationId: string, details: Record<string, unknown>) {
    await tx.select({ id: p.id }).from(p).where(eq(p.id, publicationId)).for('update');
    const ci = schema.consoleItem;
    const [open] = await tx
      .select({ id: ci.id })
      .from(ci)
      .where(and(eq(ci.kind, 'publication_failed'), eq(ci.referenceId, publicationId), eq(ci.status, 'open')));
    if (open) return;
    await tx.insert(ci).values({ businessId, kind: 'publication_failed', referenceId: publicationId, details });
  }

  async function succeed(businessId: string, publicationId: string, providerPostId: string) {
    // `published_at` waits for the provider to report the post live (finish).
    const result = await event(businessId, 'publication', publicationId, 'SUCCEEDED', async (tx) => {
      await tx.update(p).set({ providerPostId, lastError: null }).where(eq(p.id, publicationId));
      return null;
    });
    if (!result.ok) throw new Error(`publication ${publicationId}: SUCCEEDED refused (${result.reason})`);
  }

  /**
   * A failed attempt: `ATTEMPT_FAILED` below the limit, otherwise `ATTEMPTS_EXHAUSTED`. A console item
   * opens on exhaustion and on every error that did not come from the provider (`internal`).
   */
  async function fail(businessId: string, publicationId: string, error: string, options: { internal: boolean; exhausted?: boolean }): Promise<PublishOutcome> {
    const [row] = await db.withBusiness('publishing', businessId, (tx) => tx.select({ attempts: p.attempts }).from(p).where(eq(p.id, publicationId)));
    const attempts = row?.attempts ?? MAX_ATTEMPTS;
    // A provider-reported failure of a known post ends the publication at any attempt count (review of PR #52, item a).
    const exhausted = options.exhausted === true || attempts >= MAX_ATTEMPTS;
    const result = await event(businessId, 'publication', publicationId, exhausted ? 'ATTEMPTS_EXHAUSTED' : 'ATTEMPT_FAILED', async (tx) => {
      await tx.update(p).set({ lastError: error }).where(eq(p.id, publicationId));
      if (exhausted || options.internal) {
        const [pub] = await tx.select().from(p).where(eq(p.id, publicationId));
        await openFailedItem(tx, businessId, publicationId, { postId: pub!.postId, network: pub!.network, error, attempts, ...(options.internal ? { internal: true } : {}) });
      }
      return null;
    });
    if (!result.ok) throw new Error(`publication ${publicationId}: failure not recorded (${result.reason})`);
    return exhausted ? { outcome: 'failed', error } : { outcome: 'retry_pending', error };
  }

  /**
   * When every publication of the post is done and every published one is live at the provider, the
   * post's result event and the owner's template. A post the provider still holds as `scheduled` waits
   * for a later tick, so the owner is never told before the post is live.
   */
  async function finish(businessId: string, postId: string) {
    const rows = (
      await db.withBusiness('publishing', businessId, (tx) =>
        tx
          .select({ id: p.id, status: p.status, network: p.network, providerPostId: p.providerPostId, publishedAt: p.publishedAt, lastError: p.lastError })
          .from(p)
          .where(eq(p.postId, postId)),
      )
    ).sort((a, b) => NETWORKS.indexOf(a.network) - NETWORKS.indexOf(b.network)); // The owner reads the networks in a fixed order.
    if (rows.some((r) => !['published', 'failed', 'cancelled'].includes(r.status))) return;
    // A `published` publication the provider later reported failed (last_error, never live) counts as failed.
    const dropped = new Set(rows.filter((r) => r.status === 'published' && r.publishedAt === null && r.lastError !== null).map((r) => r.id));
    for (const row of rows.filter((r) => r.status === 'published' && r.publishedAt === null && !dropped.has(r.id))) {
      const status = row.providerPostId ? await provider.getPublicationStatus(row.providerPostId) : undefined;
      if (status?.status === 'scheduled') return;
      if (status?.status === 'failed') {
        // The provider dropped a post it had accepted: the team looks at it, and the post resolves (review of PR #52, item b).
        const error = status.error ?? 'the provider reports the post failed after accepting it';
        await db.withBusiness('publishing', businessId, async (tx) => {
          await tx.update(p).set({ lastError: error }).where(eq(p.id, row.id));
          await openFailedItem(tx, businessId, row.id, { postId, network: row.network, error });
        });
        dropped.add(row.id);
        continue;
      }
      const at = status?.publishedAt ? new Date(status.publishedAt) : now();
      await db.withBusiness('publishing', businessId, (tx) => tx.update(p).set({ publishedAt: at }).where(eq(p.id, row.id)));
    }
    const published = rows.filter((r) => r.status === 'published' && !dropped.has(r.id)).map((r) => r.network);
    const failed = rows.filter((r) => r.status === 'failed' || dropped.has(r.id)).map((r) => r.network);
    if (published.length + failed.length === 0) return;
    const name = failed.length === 0 ? 'ALL_PUBLISHED' : published.length === 0 ? 'ALL_FAILED' : 'PARTIALLY_PUBLISHED';
    const result = await event(businessId, 'post', postId, name);
    // Another publication of the post finished first and already moved it.
    if (!result.ok) return;
    const notice: PublishingNotice = failed.length === 0 ? { kind: 'published', postId, networks: published } : { kind: 'failed', postId, published, failed };
    try {
      await deps.notify(businessId, notice);
    } catch (error) {
      log.error('publishing notice failed', { businessId, postId, error: errorText(error) });
    }
  }

  /** Records a failed attempt; when even that fails, the publication stays `in_progress` for the tick's sweep. */
  async function failSafely(businessId: string, publicationId: string, error: string, options: { internal: boolean; exhausted?: boolean }): Promise<PublishOutcome> {
    try {
      return await fail(businessId, publicationId, error, options);
    } catch (recordError) {
      log.error('publication failure not recorded', { businessId, publicationId, error, recordError: errorText(recordError) });
      throw recordError;
    }
  }

  /**
   * One run, in a span, counted by outcome and network, and logged as one `publication attempt` line
   * (docs/observability.md, Metrics, Tracing and "Following one message"). Logging only: the run is unchanged.
   */
  async function runPublication(publicationId: string): Promise<PublishOutcome> {
    const seen: { network?: Network; postId?: string; businessId?: string } = {};
    const started = performance.now();
    return withSpan('publication run', { publicationId }, async (span) => {
      let outcome: PublishOutcome['outcome'] = 'failed';
      let reason: string | undefined;
      try {
        const result = await runPublicationOnce(publicationId, seen);
        outcome = result.outcome;
        if ('reason' in result && typeof result.reason === 'string') reason = result.reason;
        return result;
      } finally {
        span.set({ outcome, network: seen.network });
        metrics.count('postly.publications.count', { outcome, network: seen.network ?? 'none' });
        const severity = outcome === 'failed' ? log.error : outcome === 'retry_pending' ? log.warn : log.info;
        severity('publication attempt', {
          businessId: seen.businessId,
          publicationId,
          postId: seen.postId,
          network: seen.network,
          outcome,
          ...(reason ? { reason } : {}),
          durationMs: Math.round(performance.now() - started),
        });
      }
    });
  }

  async function runPublicationOnce(publicationId: string, seen: { network?: Network; postId?: string; businessId?: string }): Promise<PublishOutcome> {
    const businessId = await businessOf(publicationId);
    if (!businessId) return { outcome: 'refused', reason: 'wrong_state' };
    seen.businessId = businessId;
    const handoff = !(await deps.mayAutoReply(businessId));
    const started = await event(businessId, 'publication', publicationId, 'STARTED', (tx) => guard(tx, publicationId, handoff));
    if (!started.ok) {
      if (started.reason === 'guard_failed' && started.detail && DEFERRALS.includes(started.detail)) return { outcome: 'deferred', reason: started.detail as PublishDeferral };
      if (started.reason === 'guard_failed' && started.detail && REFUSALS.includes(started.detail)) return { outcome: 'refused', reason: started.detail as PublishRefusal };
      return { outcome: 'refused', reason: 'wrong_state' };
    }

    // From STARTED on, every error ends in retry_pending or failed (WP-35).
    let outcome: PublishOutcome;
    let postId: string | undefined;
    let stage: 'internal' | 'provider' = 'internal';
    try {
      const { pub, request } = await load(businessId, publicationId);
      seen.network = pub.network;
      seen.postId = pub.postId;
      postId = pub.postId;
      // The post's first publication moves it to publishing; for later ones the post is already there.
      await event(businessId, 'post', pub.postId, 'PUBLISHING_STARTED');
      // A retry that knows its provider post asks the provider first, so a live post is not published twice.
      stage = 'provider';
      const known = pub.providerPostId ? await provider.getPublicationStatus(pub.providerPostId) : undefined;
      if (pub.providerPostId && known && known.status !== 'failed') {
        stage = 'internal';
        await succeed(businessId, publicationId, pub.providerPostId);
        outcome = { outcome: 'already_published', providerPostId: pub.providerPostId };
      } else if (known?.status === 'failed') {
        stage = 'internal';
        // The same idempotency key would return this failed post again, so a retry cannot help (review of PR #52, item a).
        outcome = await failSafely(businessId, publicationId, known.error ?? 'the provider reports the post failed', { internal: false, exhausted: true });
      } else {
        const { providerPostId } = await provider.publish(request);
        stage = 'internal';
        await storeProviderId(businessId, publicationId, providerPostId);
        await succeed(businessId, publicationId, providerPostId);
        outcome = { outcome: 'published', providerPostId };
      }
    } catch (error) {
      outcome = await failSafely(businessId, publicationId, errorText(error), { internal: stage === 'internal' });
    }
    if (outcome.outcome !== 'retry_pending' && postId) await finish(businessId, postId);
    if (outcome.outcome === 'failed' && !postId) {
      const [row] = await db.withBusiness('publishing', businessId, (tx) => tx.select({ postId: p.postId }).from(p).where(eq(p.id, publicationId)));
      if (row) await finish(businessId, row.postId);
    }
    return outcome;
  }

  /** A run that crashed after STARTED: its publication has not moved for STALE_MS. */
  async function sweepStale(at: Date, businessId: string | undefined) {
    const stale = await db.withSystem('scheduler', (tx) =>
      tx
        .select({ id: p.id, businessId: p.businessId, postId: p.postId })
        .from(p)
        .where(and(businessId ? eq(p.businessId, businessId) : undefined, eq(p.status, 'in_progress'), lte(p.updatedAt, new Date(at.getTime() - STALE_MS)))),
    );
    for (const row of stale) {
      const outcome = await fail(row.businessId, row.id, 'attempt interrupted', { internal: true });
      if (outcome.outcome === 'failed') await finish(row.businessId, row.postId);
    }
  }

  /** Posts whose publications are done but not all confirmed live yet. */
  async function settle(businessId: string | undefined) {
    const waiting = await db.withSystem('scheduler', (tx) =>
      tx
        .selectDistinct({ businessId: p.businessId, postId: p.postId })
        .from(p)
        .where(and(businessId ? eq(p.businessId, businessId) : undefined, eq(p.status, 'published'), isNull(p.publishedAt), isNull(p.lastError))),
    );
    for (const row of waiting) await finish(row.businessId, row.postId);
  }

  return {
    runPublication,

    async tick(at, options = {}) {
      const due = await db.withSystem('scheduler', (tx) =>
        tx
          .select({ id: p.id })
          .from(p)
          .where(
            and(
              options.businessId ? eq(p.businessId, options.businessId) : undefined,
              or(
              and(eq(p.status, 'scheduled'), lte(p.scheduledFor, at)),
              and(eq(p.status, 'retry_pending'), lte(p.attempts, 1), lte(p.updatedAt, new Date(at.getTime() - RETRY_DELAYS_MS[0]!))),
                and(eq(p.status, 'retry_pending'), sql`${p.attempts} >= 2`, lte(p.updatedAt, new Date(at.getTime() - RETRY_DELAYS_MS[1]!))),
              ),
            ),
          )
          .orderBy(p.scheduledFor),
      );
      for (const { id } of due) {
        try {
          await runPublication(id);
        } catch (error) {
          log.error('publication run failed', { publicationId: id, error: errorText(error) });
        }
      }
      for (const [msg, step] of [['stale publication sweep failed', () => sweepStale(at, options.businessId)], ['publication settle failed', () => settle(options.businessId)]] as const) {
        try {
          await step();
        } catch (error) {
          log.error(msg, { error: errorText(error) });
        }
      }
      return { ran: due.length };
    },
  };
}
