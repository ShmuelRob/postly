import { describe, expect, it } from 'vitest';
import { createMemoryQueue } from './db/index.js';
import { PUBLISHING_TICK_JOB, WEEKLY_TICK_JOB, startWorkerProcess } from './worker.js';

const publishing = { tick: async () => ({ ran: 0 }) };

describe('worker process', () => {
  it('schedules the weekly tick hourly as a singleton job', async () => {
    const queue = createMemoryQueue();
    await startWorkerProcess({ queue, weekly: { tick: async () => {} }, publishing });
    expect(queue.schedules()).toEqual([
      { name: WEEKLY_TICK_JOB, cron: '0 * * * *', singleton: true },
      { name: PUBLISHING_TICK_JOB, cron: '* * * * *', singleton: true },
    ]);
  });

  it('runs WeeklyUpdates.tick with the current time when the schedule fires', async () => {
    const queue = createMemoryQueue();
    const ticks: Date[] = [];
    const at = new Date('2026-11-03T09:00:00Z');
    await startWorkerProcess({ queue, weekly: { tick: async (now) => void ticks.push(now) }, publishing, now: () => at });
    await queue.fire(WEEKLY_TICK_JOB);
    expect(await queue.drain()).toBe(1);
    expect(ticks).toEqual([at]);
  });

  it('lets a failing tick fail the job so pg-boss retries it', async () => {
    const queue = createMemoryQueue();
    await startWorkerProcess({ queue, weekly: { tick: async () => { throw new Error('db down'); } }, publishing });
    await queue.fire(WEEKLY_TICK_JOB);
    await expect(queue.drain()).rejects.toThrow('db down');
  });

  it('runs Publishing.tick every minute with the current time (WP-34)', async () => {
    const queue = createMemoryQueue();
    const ticks: Date[] = [];
    const at = new Date('2026-11-04T08:01:00Z');
    await startWorkerProcess({ queue, weekly: { tick: async () => {} }, publishing: { tick: async (now) => (ticks.push(now), { ran: 1 }) }, now: () => at });
    await queue.fire(PUBLISHING_TICK_JOB);
    expect(await queue.drain()).toBe(1);
    expect(ticks).toEqual([at]);
  });
});
