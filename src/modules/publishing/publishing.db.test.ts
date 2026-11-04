import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, inject, it } from 'vitest';
import { BusinessProfile } from '../../contracts/business-profile.js';
import { createDatabase } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { MessagingSimulator, PublishingSimulator } from '../../simulators/index.js';
import { createH5World, type H5World } from '../../../test/h5/world.js';
import { createWorkflow } from '../workflow/index.js';
import { createChannels } from './index.js';

// WP-34 (technical-design.md, Scheduling and publishing flow): the channel test validates a schedule
// and publishes nothing; the schedule conversation hands time changes and missing channels to a person.
// The H5 world (test/h5/subject.ts) builds the real app on the simulators.

const APPROVER = '+972501233461';
const db = createDatabase(inject('databaseUrls'), { max: 3 });
let world: H5World | undefined;
let publishing: PublishingSimulator;
let messaging: MessagingSimulator;
const NOW = new Date('2026-11-03T08:00:00.000Z');

async function open() {
  messaging = new MessagingSimulator();
  publishing = new PublishingSimulator({ now: () => NOW });
  world = await createH5World({ messaging, publishing, now: () => NOW, databaseUrls: inject('databaseUrls') });
  return world;
}
afterAll(() => db.close());
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const read = <T>(fn: Parameters<typeof db.withSystem<T>>[1]) => db.withSystem('console', fn);
const step = async (businessId: string) =>
  (await read((tx) => tx.select({ step: schema.conversationState.step, handoffAt: schema.conversationState.handoffAt }).from(schema.conversationState).where(eq(schema.conversationState.businessId, businessId))))[0];
const items = (businessId: string) => read((tx) => tx.select().from(schema.consoleItem).where(eq(schema.consoleItem.businessId, businessId)));
const tap = (postId: string, versionHash: string) => messaging.inboundButtonTap(APPROVER, { action: 'approve', postId, versionHash });
const text = (t: string) => ({ ...messaging.inbound(APPROVER, { kind: 'text', text: t }), providerMessageId: `t-${crypto.randomUUID()}` });

describe('the channel test (state-machines.md, Channel connection)', { timeout: 30_000 }, () => {
  it('a failed test schedule leaves the channel unverified and pending, publishes nothing, and passes on the next try', async () => {
    const w = await open();
    const businessId = await w.createBusiness(APPROVER);
    const workflow = createWorkflow(db);
    const channels = createChannels({ db, provider: publishing, apply: (b, r) => workflow.apply(b, r) });
    await channels.requestLink(businessId, ['instagram']);
    publishing.connect(businessId, 'instagram');
    publishing.failNextTestSchedule('no publishing permission');

    expect(await channels.checkAndTest(businessId)).toEqual([{ network: 'instagram', status: 'pending' }]);
    expect(await channels.checkAndTest(businessId)).toEqual([{ network: 'instagram', status: 'verified' }]);
    expect(publishing.scheduleTests).toHaveLength(2);
    expect(publishing.posts).toEqual([]);
  });
});

describe('the schedule conversation (technical-design.md, Scheduling and publishing flow)', { timeout: 30_000 }, () => {
  async function confirming(w: H5World) {
    const businessId = await w.createBusiness(APPROVER);
    await w.connectChannel(businessId, 'instagram');
    await w.connectChannel(businessId, 'facebook');
    const draft = await w.createDraft(businessId, 'צבעונים חדשים הגיעו, 25 ₪ לזר');
    await w.app.deliverInbound(tap(draft.postId, draft.versionHash));
    expect((await step(businessId))?.step).toBe('confirming_schedule');
    return { businessId, draft };
  }

  it('any other answer to the proposed times goes to a person and schedules nothing', async () => {
    const w = await open();
    const { businessId, draft } = await confirming(w);
    await w.app.deliverInbound(text('אפשר ביום שני בבוקר?'));

    expect((await step(businessId))?.handoffAt).not.toBeNull();
    expect((await items(businessId)).map((i) => [i.kind, (i.details as { reason?: string }).reason])).toContainEqual(['handoff', 'schedule change requested']);
    expect(await read((tx) => tx.select().from(schema.publication).where(eq(schema.publication.postId, draft.postId)))).toEqual([]);
  });

  it('a channel that dropped before the confirmation: the owner is told, the team gets an item, nothing is scheduled', async () => {
    const w = await open();
    const { businessId, draft } = await confirming(w);
    await read((tx) =>
      tx
        .update(schema.channelConnection)
        .set({ status: 'disconnected' })
        .where(and(eq(schema.channelConnection.businessId, businessId), eq(schema.channelConnection.network, 'facebook'))),
    );
    await w.app.deliverInbound(text('כן'));

    expect(messaging.sent.at(-1)?.request).toMatchObject({ text: expect.stringContaining('פייסבוק לא מחובר') });
    expect((await items(businessId)).map((i) => i.kind)).toEqual(expect.arrayContaining(['channel_disconnected', 'handoff']));
    expect(await read((tx) => tx.select().from(schema.publication).where(eq(schema.publication.postId, draft.postId)))).toEqual([]);
    const [business] = await read((tx) => tx.select({ profile: schema.business.profile }).from(schema.business).where(eq(schema.business.id, businessId)));
    expect(BusinessProfile.parse(business!.profile).channels).toEqual(['instagram', 'facebook']);
  });
});

