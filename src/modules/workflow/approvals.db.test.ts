import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, inject, it } from 'vitest';
import { BusinessProfile } from '../../contracts/business-profile.js';
import { createDatabase } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { MessagingSimulator, PublishingSimulator } from '../../simulators/index.js';
import { createH5World, type H5World } from '../../../test/h5/world.js';
import { CHANGE_REFUSED } from './drafts.js';
import { createDrafts, createWorkflow, type Approvals } from './index.js';

// Review of PR #48: scheduling publishes only to the approved version's networks; only an active
// business approves; a change refused after its approval was invalidated reaches the console.
// The H5 world (test/h5/subject.ts) builds the real app on the simulators.

const APPROVER = '+972501233451';
const SCHEDULED_FOR = '2026-11-04T08:00:00.000Z';
const db = createDatabase(inject('databaseUrls'), { max: 3 });
let world: H5World | undefined;
let publishing: PublishingSimulator;
let messaging: MessagingSimulator;

async function open() {
  messaging = new MessagingSimulator();
  publishing = new PublishingSimulator();
  world = await createH5World({ messaging, publishing, now: () => new Date('2026-11-03T08:00:00.000Z'), databaseUrls: inject('databaseUrls') });
  return world;
}
afterAll(() => db.close());
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const tap = (postId: string, versionHash: string) => messaging.inboundButtonTap(APPROVER, { action: 'approve', postId, versionHash });
const postStatus = async (postId: string) =>
  (await db.withSystem('console', (tx) => tx.select({ s: schema.post.status }).from(schema.post).where(eq(schema.post.id, postId))))[0]?.s;
const publications = (postId: string) =>
  db.withSystem('console', (tx) => tx.select({ network: schema.publication.network }).from(schema.publication).where(eq(schema.publication.postId, postId)));

async function setChannels(businessId: string, channels: ('instagram' | 'facebook')[]) {
  await db.withSystem('console', async (tx) => {
    const [row] = await tx.select({ profile: schema.business.profile }).from(schema.business).where(eq(schema.business.id, businessId));
    const profile = BusinessProfile.parse({ ...(row!.profile as object), channels });
    await tx.update(schema.business).set({ profile }).where(eq(schema.business.id, businessId));
  });
}

describe('scheduling follows the approved version', { timeout: 30_000 }, () => {
  it('a post narrowed to Instagram gets only an Instagram publication, with both channels verified', async () => {
    const w = await open();
    const businessId = await w.createBusiness(APPROVER);
    await setChannels(businessId, ['instagram']);
    await w.connectChannel(businessId, 'instagram');
    await w.connectChannel(businessId, 'facebook');
    const draft = await w.createDraft(businessId, 'צבעונים חדשים, 25 ₪ לזר');
    expect((await w.approval.handleApprovalReply(businessId, tap(draft.postId, draft.versionHash))).outcome).toBe('approved');

    const scheduled = await w.schedule(businessId, draft.postId, SCHEDULED_FOR);

    expect(scheduled.map((p) => p.network)).toEqual(['instagram']);
    expect(await publications(draft.postId)).toEqual([{ network: 'instagram' }]);
    expect(await postStatus(draft.postId)).toBe('scheduled');
  });

  it('a network of the approved version with no verified connection schedules nothing', async () => {
    const w = await open();
    const businessId = await w.createBusiness(APPROVER);
    await w.connectChannel(businessId, 'instagram');
    const draft = await w.createDraft(businessId, 'צבעונים חדשים, 25 ₪ לזר');
    await w.approval.handleApprovalReply(businessId, tap(draft.postId, draft.versionHash));

    await expect(w.schedule(businessId, draft.postId, SCHEDULED_FOR)).rejects.toThrow(/no verified connection for facebook/);

    expect(await publications(draft.postId)).toEqual([]);
    expect(await postStatus(draft.postId)).toBe('approved');
  });
});

describe('only an active business approves', { timeout: 30_000 }, () => {
  it('an approve tap on a paused business is refused and changes nothing', async () => {
    const w = await open();
    const businessId = await w.createBusiness(APPROVER);
    const draft = await w.createDraft(businessId, 'צבעונים חדשים, 25 ₪ לזר');
    await db.withSystem('console', (tx) => tx.update(schema.business).set({ status: 'paused' }).where(eq(schema.business.id, businessId)));

    expect(await w.approval.handleApprovalReply(businessId, tap(draft.postId, draft.versionHash))).toEqual({ outcome: 'refused', reason: 'wrong_state' });
    expect(await postStatus(draft.postId)).toBe('awaiting_approval');
  });
});

describe('a change refused after invalidation', { timeout: 30_000 }, () => {
  it('opens a draft_failed console item, and the post cannot publish', async () => {
    const w = await open();
    const businessId = await w.createBusiness(APPROVER);
    const draft = await w.createDraft(businessId, 'צבעונים חדשים, 25 ₪ לזר');
    await w.approval.handleApprovalReply(businessId, tap(draft.postId, draft.versionHash));
    await db.withSystem('console', (tx) =>
      tx
        .update(schema.conversationState)
        .set({ openQuestion: { key: 'change_request', askedFields: [], attempts: 1, photoAssetIds: [], postId: draft.postId } })
        .where(eq(schema.conversationState.businessId, businessId)),
    );
    // A concurrent change won the post: its CHANGE_REQUESTED is refused.
    const real = createWorkflow(db, { rejected: () => {} });
    const workflow = { ...real, apply: (b: string, r: Parameters<typeof real.apply>[1]) => (r.machine === 'post' && r.event === 'CHANGE_REQUESTED' ? Promise.resolve({ ok: false as const, reason: 'invalid_transition' as const }) : real.apply(b, r)) };
    const drafts = createDrafts({
      db,
      workflow,
      messaging: { sendText: async () => undefined, sendButtons: async () => undefined },
      model: {
        run: async (_b, task) =>
          (task === 'intent_detection' ? { intent: 'change_request', confidence: 0.9 } : { changes: [{ target: 'caption', instruction: '30 ₪' }] }) as never,
      },
      render: async () => ({}),
      mediaUrl: async () => '',
      urlFor: (p) => p,
      readFile: async () => undefined,
      samplePhotoUrl: '',
      invalidate: (b, p) => (w.approval as Approvals).invalidate(b, p),
    });

    await drafts.handle({ businessId, from: APPROVER, text: 'המחיר 30 ₪', messages: [{ id: randomUUID(), content: { kind: 'text' }, mediaAssetIds: [] }] });

    const items = await db.withSystem('console', (tx) =>
      tx.select().from(schema.consoleItem).where(and(eq(schema.consoleItem.businessId, businessId), eq(schema.consoleItem.kind, 'draft_failed'))),
    );
    expect(items.map((i) => [i.referenceId, (i.details as { reason: string }).reason])).toEqual([[draft.postId, CHANGE_REFUSED]]);
    const approvals = await db.withSystem('console', (tx) => tx.select({ at: schema.approval.invalidatedAt }).from(schema.approval).where(eq(schema.approval.postId, draft.postId)));
    expect(approvals.every((a) => a.at !== null)).toBe(true);
    expect(await postStatus(draft.postId)).toBe('approved');
  });
});
