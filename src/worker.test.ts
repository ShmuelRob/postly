import { describe, expect, it } from 'vitest';
import { createMemoryQueue } from './db/index.js';
import { BILLING_HOLD_JOB, BUSINESS_ARCHIVE_JOB, CHANNEL_HEALTH_JOB, MONTHLY_REPORT_JOB, PUBLISHING_TICK_JOB, RETIRED_DATA_DELETION_JOB, WEEKLY_TICK_JOB, startWorkerProcess } from './worker.js';

const publishing = { tick: async () => ({ ran: 0 }) };
const channelHealth = { tick: async () => {} };

describe('worker process', () => {
  it('schedules the weekly tick hourly as a singleton job', async () => {
    const queue = createMemoryQueue();
    await startWorkerProcess({ queue, weekly: { tick: async () => {} }, publishing, channelHealth });
    expect(queue.schedules()).toEqual([
      { name: WEEKLY_TICK_JOB, cron: '0 * * * *', singleton: true },
      { name: PUBLISHING_TICK_JOB, cron: '* * * * *', singleton: true },
      { name: CHANNEL_HEALTH_JOB, cron: '0 4 * * *', singleton: true },
    ]);
  });

  it('runs WeeklyUpdates.tick with the current time when the schedule fires', async () => {
    const queue = createMemoryQueue();
    const ticks: Date[] = [];
    const at = new Date('2026-11-03T09:00:00Z');
    await startWorkerProcess({ queue, weekly: { tick: async (now) => void ticks.push(now) }, publishing, channelHealth, now: () => at });
    await queue.fire(WEEKLY_TICK_JOB);
    expect(await queue.drain()).toBe(1);
    expect(ticks).toEqual([at]);
  });

  it('lets a failing tick fail the job so pg-boss retries it', async () => {
    const queue = createMemoryQueue();
    await startWorkerProcess({ queue, weekly: { tick: async () => { throw new Error('db down'); } }, publishing, channelHealth });
    await queue.fire(WEEKLY_TICK_JOB);
    await expect(queue.drain()).rejects.toThrow('db down');
  });

  it('runs Publishing.tick every minute with the current time (WP-34)', async () => {
    const queue = createMemoryQueue();
    const ticks: Date[] = [];
    const at = new Date('2026-11-04T08:01:00Z');
    await startWorkerProcess({ queue, weekly: { tick: async () => {} }, publishing: { tick: async (now) => (ticks.push(now), { ran: 1 }) }, channelHealth, now: () => at });
    await queue.fire(PUBLISHING_TICK_JOB);
    expect(await queue.drain()).toBe(1);
    expect(ticks).toEqual([at]);
  });

  it('schedules the daily business archive and the monthly report, each with the current time, and removes the old data deletion schedule (2026-11-07)', async () => {
    const queue = createMemoryQueue();
    const at = new Date('2026-12-01T06:00:00Z');
    const ran: [string, Date][] = [];
    await startWorkerProcess({
      queue,
      weekly: { tick: async () => {} },
      publishing,
      channelHealth,
      archive: { tick: async (now) => void ran.push(['archive', now]) },
      monthlyReport: { tick: async (now) => void ran.push(['report', now]) },
      now: () => at,
    });
    expect(queue.schedules().slice(3)).toEqual([
      { name: BUSINESS_ARCHIVE_JOB, cron: '0 3 * * *', singleton: true },
      { name: MONTHLY_REPORT_JOB, cron: '0 6 1 * *', singleton: true },
    ]);
    expect(queue.unscheduled()).toEqual([RETIRED_DATA_DELETION_JOB]);
    await queue.fire(BUSINESS_ARCHIVE_JOB);
    await queue.fire(MONTHLY_REPORT_JOB);
    expect(await queue.drain()).toBe(2);
    expect(ran).toEqual([['archive', at], ['report', at]]);
  });

  it('schedules the daily billing hold with the current time (T16)', async () => {
    const queue = createMemoryQueue();
    const at = new Date('2026-11-10T05:00:00Z');
    const ran: Date[] = [];
    await startWorkerProcess({ queue, weekly: { tick: async () => {} }, publishing, channelHealth, billingHold: { tick: async (now) => void ran.push(now) }, now: () => at });
    expect(queue.schedules().slice(3)).toEqual([{ name: BILLING_HOLD_JOB, cron: '0 5 * * *', singleton: true }]);
    await queue.fire(BILLING_HOLD_JOB);
    expect(await queue.drain()).toBe(1);
    expect(ran).toEqual([at]);
  });
});
