import type { JobQueue } from './db/index.js';
import type { Publishing } from './modules/publishing/index.js';
import type { WeeklyUpdates } from './modules/workflow/index.js';

/** The hourly weekly-update scheduler job (technical-design.md, Weekly update flow). */
export const WEEKLY_TICK_JOB = 'weekly-update-tick';
export const WEEKLY_TICK_CRON = '0 * * * *';
/** The publishing job's tick (technical-design.md, Scheduling and publishing flow). */
export const PUBLISHING_TICK_JOB = 'publishing-tick';
export const PUBLISHING_TICK_CRON = '* * * * *';
/** The daily channel health check (technical-design.md, Failure handling): 04:00 UTC, 06:00 or 07:00 in Israel. */
export const CHANNEL_HEALTH_JOB = 'channel-health-check';
export const CHANNEL_HEALTH_CRON = '0 4 * * *';
/** The daily data deletion (WP-43): cancelled businesses past `data_delete_after`. */
export const DATA_DELETION_JOB = 'data-deletion';
export const DATA_DELETION_CRON = '0 3 * * *';
/** The monthly report (WP-43): 06:00 UTC on the first of each month. */
export const MONTHLY_REPORT_JOB = 'monthly-report';
export const MONTHLY_REPORT_CRON = '0 6 1 * *';
/** The daily billing hold (T16): reminders in the grace period, then the business pause. */
export const BILLING_HOLD_JOB = 'billing-hold';
export const BILLING_HOLD_CRON = '0 5 * * *';

export interface WorkerProcessOptions {
  queue: JobQueue;
  weekly: Pick<WeeklyUpdates, 'tick'>;
  publishing: Pick<Publishing, 'tick'>;
  channelHealth: { tick(now: Date): Promise<void> };
  dataDeletion?: { tick(now: Date): Promise<unknown> };
  monthlyReport?: { tick(now: Date): Promise<unknown> };
  billingHold?: { tick(now: Date): Promise<unknown> };
  now?: () => Date;
}

/**
 * The worker process (technical-design.md): registers the scheduled jobs on the queue. The weekly
 * tick is a pg-boss singleton schedule, so with several worker instances only one tick runs at a
 * time and each hour's cron job is created once. A tick that throws fails the job and is retried;
 * `WeeklyUpdates.tick` already isolates one business's failure from the others.
 */
export async function startWorkerProcess(options: WorkerProcessOptions): Promise<JobQueue> {
  const now = options.now ?? (() => new Date());
  await options.queue.schedule(WEEKLY_TICK_JOB, WEEKLY_TICK_CRON, () => options.weekly.tick(now()));
  await options.queue.schedule(PUBLISHING_TICK_JOB, PUBLISHING_TICK_CRON, async () => void (await options.publishing.tick(now())));
  await options.queue.schedule(CHANNEL_HEALTH_JOB, CHANNEL_HEALTH_CRON, () => options.channelHealth.tick(now()));
  const { dataDeletion, monthlyReport, billingHold } = options;
  if (dataDeletion) await options.queue.schedule(DATA_DELETION_JOB, DATA_DELETION_CRON, async () => void (await dataDeletion.tick(now())));
  if (monthlyReport) await options.queue.schedule(MONTHLY_REPORT_JOB, MONTHLY_REPORT_CRON, async () => void (await monthlyReport.tick(now())));
  if (billingHold) await options.queue.schedule(BILLING_HOLD_JOB, BILLING_HOLD_CRON, async () => void (await billingHold.tick(now())));
  return options.queue;
}
