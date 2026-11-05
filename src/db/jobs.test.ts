import { describe, expect, it } from 'vitest';
import { createMemoryQueue, JOBS_POOL, pgBossConstructorOptions, startWorker } from './jobs.js';
import { memoryTelemetry } from '../shared/telemetry-memory.js';

describe('job queue', () => {
  it('runs a registered handler with the job data', async () => {
    const seen: unknown[] = [];
    const queue = await startWorker(createMemoryQueue(), { ping: async (data) => void seen.push(data) });
    await queue.send('ping', { n: 1 });
    await queue.send('ping', { n: 2 });
    expect(await queue.drain()).toBe(2);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('rejects a job without a handler and a second handler for one name', async () => {
    const queue = createMemoryQueue();
    await expect(queue.send('missing', {})).rejects.toThrow('no handler');
    await queue.register('ping', async () => {});
    await expect(queue.register('ping', async () => {})).rejects.toThrow('already registered');
  });
});

describe('pg-boss pool (D7, WP-87)', () => {
  it('caps pg-boss at JOBS_POOL connections, the number the connection budget counts', () => {
    expect(pgBossConstructorOptions({ connectionString: 'postgres://app_jobs@db/p' }).max).toBe(JOBS_POOL);
    expect(JOBS_POOL).toBe(10);
  });
});

// docs/observability.md, Metrics (WP-48): job durations and failures, one span per job run.
describe('job metrics and spans', () => {
  it('records the duration and outcome of every job run, and a failure count when it throws', async () => {
    const telemetry = memoryTelemetry();
    try {
      const queue = await startWorker(createMemoryQueue(), {
        'weekly-tick': async () => {},
        'monthly-report': async () => {
          throw new Error('boom');
        },
      });
      await queue.send('weekly-tick', null);
      await queue.drain();
      await queue.send('monthly-report', null);
      await expect(queue.drain()).rejects.toThrow('boom');

      const durations = await telemetry.points('postly.jobs.duration');
      expect(durations.map((p) => [p.labels, p.count])).toEqual(
        expect.arrayContaining([
          [{ job: 'weekly-tick', outcome: 'ok' }, 1],
          [{ job: 'monthly-report', outcome: 'failed' }, 1],
        ]),
      );
      expect(await telemetry.points('postly.jobs.failures.count')).toEqual([{ labels: { job: 'monthly-report' }, value: 1 }]);
      expect(telemetry.spans().map((s) => [s.name, s.status])).toEqual([
        ['job weekly-tick', 'OK'],
        ['job monthly-report', 'ERROR'],
      ]);
    } finally {
      telemetry.stop();
    }
  });
});
