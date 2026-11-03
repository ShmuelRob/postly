import { MessagingSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { createH5World, type H5World } from './world.js';

export const APPROVER = '+972501234567';
export const OTHER_APPROVER = '+972501234568';
export const STRANGER = '+972501234569';
export const SCHEDULED_FOR = '2026-11-04T08:00:00.000Z';
/** A well-formed hash that is no version's hash. */
export const UNKNOWN_HASH = 'f'.repeat(64);

export interface Setup {
  world: H5World;
  messaging: MessagingSimulator;
  publishing: PublishingSimulator;
  /** Moves the shared clock, for example past `scheduledFor` before the job runs. */
  setNow(iso: string): void;
}

export async function setup(): Promise<Setup> {
  let now = new Date('2026-11-03T08:00:00.000Z');
  const clock = () => now;
  const messaging = new MessagingSimulator();
  const publishing = new PublishingSimulator({ now: clock });
  const world = await createH5World({ messaging, publishing, now: clock });
  return { world, messaging, publishing, setNow: (iso) => (now = new Date(iso)) };
}

/** A business with Instagram and Facebook connected and a draft awaiting approval. */
export async function businessWithDraft(s: Setup, approver = APPROVER, caption = 'צבעונים חדשים הגיעו, 25 ₪ לזר') {
  const businessId = await s.world.createBusiness(approver);
  await s.world.connectChannel(businessId, 'instagram');
  await s.world.connectChannel(businessId, 'facebook');
  const draft = await s.world.createDraft(businessId, caption);
  return { businessId, draft };
}
