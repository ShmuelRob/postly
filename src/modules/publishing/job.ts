import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { PublishDeferral, PublishingJob, PublishOutcome, PublishRefusal } from '../../contracts/approval.js';
import type { Network } from '../../contracts/common.js';
import type { PublishingProvider } from '../../contracts/providers/publishing.js';
import type { Database, Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';

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

  async function succeed(businessId: string, publicationId: string, providerPostId: string) {
    const result = await event(businessId, 'publication', publicationId, 'SUCCEEDED', async (tx) => {
      await tx.update(p).set({ providerPostId, publishedAt: now(), lastError: null }).where(eq(p.id, publicationId));
      return null;
    });
    if (!result.ok) throw new Error(`publication ${publicationId}: SUCCEEDED refused (${result.reason})`);
  }

  async function fail(businessId: string, publicationId: string, attempts: number, error: string): Promise<PublishOutcome> {
    const exhausted = attempts >= MAX_ATTEMPTS;
    const result = await event(businessId, 'publication', publicationId, exhausted ? 'ATTEMPTS_EXHAUSTED' : 'ATTEMPT_FAILED', async (tx) => {
      await tx.update(p).set({ lastError: error }).where(eq(p.id, publicationId));
      if (exhausted) {
        const [pub] = await tx.select().from(p).where(eq(p.id, publicationId));
        await tx.insert(schema.consoleItem).values({
          businessId,
          kind: 'publication_failed',
          referenceId: publicationId,
          details: { postId: pub!.postId, network: pub!.network, error, attempts },
        });
      }
      return null;
    });
    if (!result.ok) throw new Error(`publication ${publicationId}: failure not recorded (${result.reason})`);
    return exhausted ? { outcome: 'failed', error } : { outcome: 'retry_pending', error };
  }

  /** When every publication of the post is done, the post's result event and the owner's template. */
  async function finish(businessId: string, postId: string) {
    const rows = await db.withBusiness('publishing', businessId, (tx) =>
      tx.select({ status: p.status, network: p.network }).from(p).where(eq(p.postId, postId)),
    );
    if (rows.some((r) => !['published', 'failed', 'cancelled'].includes(r.status))) return;
    const published = rows.filter((r) => r.status === 'published').map((r) => r.network);
    const failed = rows.filter((r) => r.status === 'failed').map((r) => r.network);
    if (published.length + failed.length === 0) return;
    const name = failed.length === 0 ? 'ALL_PUBLISHED' : published.length === 0 ? 'ALL_FAILED' : 'PARTIALLY_PUBLISHED';
    const result = await event(businessId, 'post', postId, name);
    // Another publication of the post finished first and already moved it.
    if (!result.ok) return;
    const notice: PublishingNotice = failed.length === 0 ? { kind: 'published', postId, networks: published } : { kind: 'failed', postId, published, failed };
    try {
      await deps.notify(businessId, notice);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', msg: 'publishing notice failed', businessId, postId, error: errorText(error) }));
    }
  }

  async function runPublication(publicationId: string): Promise<PublishOutcome> {
    const businessId = await businessOf(publicationId);
    if (!businessId) return { outcome: 'refused', reason: 'wrong_state' };
    const handoff = !(await deps.mayAutoReply(businessId));
    const started = await event(businessId, 'publication', publicationId, 'STARTED', (tx) => guard(tx, publicationId, handoff));
    if (!started.ok) {
      if (started.reason === 'guard_failed' && started.detail && DEFERRALS.includes(started.detail)) return { outcome: 'deferred', reason: started.detail as PublishDeferral };
      if (started.reason === 'guard_failed' && started.detail && REFUSALS.includes(started.detail)) return { outcome: 'refused', reason: started.detail as PublishRefusal };
      return { outcome: 'refused', reason: 'wrong_state' };
    }

    const { pub, request } = await load(businessId, publicationId);
    // The post's first publication moves it to publishing; for later ones the post is already there.
    await event(businessId, 'post', pub.postId, 'PUBLISHING_STARTED');

    let outcome: PublishOutcome;
    try {
      // A retry that knows its provider post asks the provider first, so a live post is not published twice.
      const known = pub.providerPostId ? await provider.getPublicationStatus(pub.providerPostId) : undefined;
      if (pub.providerPostId && known && known.status !== 'failed') {
        await succeed(businessId, publicationId, pub.providerPostId);
        outcome = { outcome: 'already_published', providerPostId: pub.providerPostId };
      } else if (known?.status === 'failed') {
        outcome = await fail(businessId, publicationId, pub.attempts, known.error ?? 'the provider reports the post failed');
      } else {
        const { providerPostId } = await provider.publish(request);
        await succeed(businessId, publicationId, providerPostId);
        outcome = { outcome: 'published', providerPostId };
      }
    } catch (error) {
      outcome = await fail(businessId, publicationId, pub.attempts, errorText(error));
    }
    if (outcome.outcome !== 'retry_pending') await finish(businessId, pub.postId);
    return outcome;
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
          console.error(JSON.stringify({ level: 'error', msg: 'publication run failed', publicationId: id, error: errorText(error) }));
        }
      }
      return { ran: due.length };
    },
  };
}
