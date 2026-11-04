import type { JobQueue } from './db/index.js';
import type { Publishing } from './modules/publishing/index.js';
import type { WeeklyUpdates } from './modules/workflow/index.js';

/** The hourly weekly-update scheduler job (technical-design.md, Weekly update flow). */
export const WEEKLY_TICK_JOB = 'weekly-update-tick';
export const WEEKLY_TICK_CRON = '0 * * * *';
/** The publishing job's tick (technical-design.md, Scheduling and publishing flow). */
export const PUBLISHING_TICK_JOB = 'publishing-tick';
export const PUBLISHING_TICK_CRON = '* * * * *';

export interface WorkerProcessOptions {
  queue: JobQueue;
  weekly: Pick<WeeklyUpdates, 'tick'>;
  publishing: Pick<Publishing, 'tick'>;
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
  return options.queue;
}
