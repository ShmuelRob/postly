import { inject } from 'vitest';
import { MessagingSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { openH5Db, type H5Db } from './db.js';
import { createH5World, type H5World } from './world.js';

export const APPROVER = '+972501234567';
export const OTHER_APPROVER = '+972501234568';
export const STRANGER = '+972501234569';
export const SCHEDULED_FOR = '2026-11-04T08:00:00.000Z';
export const DUE = '2026-11-04T08:01:00.000Z';
/** A well-formed hash that is no version's hash. */
export const UNKNOWN_HASH = 'f'.repeat(64);
export const CAPTION = 'צבעונים חדשים הגיעו, 25 ₪ לזר';
export const CHANGED_CAPTION = 'צבעונים חדשים הגיעו, 30 ₪ לזר';

export interface Setup {
  world: H5World;
  db: H5Db;
  messaging: MessagingSimulator;
  publishing: PublishingSimulator;
  /** Moves the shared clock, for example past `scheduledFor` before the job runs. */
  setNow(iso: string): void;
  close(): Promise<void>;
}

export async function setup(): Promise<Setup> {
  let now = new Date('2026-11-03T08:00:00.000Z');
  const clock = () => now;
  const messaging = new MessagingSimulator();
  const publishing = new PublishingSimulator({ now: clock });
  const db = openH5Db();
  let world: H5World;
  try {
    world = await createH5World({ messaging, publishing, now: clock, databaseUrls: inject('databaseUrls') });
  } catch (error) {
    await db.close();
    throw error;
  }
  return {
    world,
    db,
    messaging,
    publishing,
    setNow: (iso) => (now = new Date(iso)),
    close: async () => {
      await db.setGlobalPause(false);
      await world.close();
      await db.close();
    },
  };
}

/** A business with Instagram and Facebook connected and a draft awaiting approval. */
export async function businessWithDraft(s: Setup, approver = APPROVER, caption = CAPTION) {
  const businessId = await s.world.createBusiness(approver);
  await s.world.connectChannel(businessId, 'instagram');
  await s.world.connectChannel(businessId, 'facebook');
  const draft = await s.world.createDraft(businessId, caption);
  return { businessId, draft };
}

/** Approves a draft with the approver's tap; throws if the approval is refused. */
export async function approve(s: Setup, businessId: string, postId: string, versionHash: string, approver = APPROVER) {
  const decision = await s.world.approval.handleApprovalReply(
    businessId,
    s.messaging.inboundButtonTap(approver, { action: 'approve', postId, versionHash }),
  );
  if (decision.outcome !== 'approved') throw new Error(`setup: approval refused (${decision.reason})`);
  return decision.approvalId;
}
