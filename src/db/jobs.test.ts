import { describe, expect, it } from 'vitest';
import { createMemoryQueue, createSendOnlyQueue, JOBS_POOL, observeQueueDepth, pgBossConstructorOptions, startWorker } from './jobs.js';
import { setLogSink } from '../shared/logger.js';
import { currentMeter } from '../shared/telemetry.js';
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

// Cloud SQL (docs/deployment.md): every URL says sslmode=require, which postgres.js reads as libpq does
// (encrypt, no certificate check). pg, under pg-boss, reads it as verify-full, and the Cloud SQL server
// certificate is not signed by a public CA, so the first dev migrate failed with "unable to verify the
// first certificate". pg-boss gets libpq semantics too.
describe('pg-boss TLS mode (Cloud SQL)', () => {
  it('reads sslmode=require as libpq does: encrypted, no CA check', () => {
    const { connectionString } = pgBossConstructorOptions({ connectionString: 'postgres://app_jobs:pw@10.0.0.3:5432/postly?sslmode=require' });
    const url = new URL(connectionString);
    expect(url.searchParams.get('sslmode')).toBe('require');
    expect(url.searchParams.get('uselibpqcompat')).toBe('true');
  });

  it('leaves a URL without sslmode, or with its own choice, unchanged', () => {
    expect(pgBossConstructorOptions({ connectionString: 'postgres://app_jobs@db/p' }).connectionString).toBe('postgres://app_jobs@db/p');
    const verified = 'postgres://app_jobs@db/p?sslmode=verify-full';
    expect(pgBossConstructorOptions({ connectionString: verified }).connectionString).toBe(verified);
    const explicit = 'postgres://app_jobs@db/p?sslmode=require&uselibpqcompat=false';
    expect(pgBossConstructorOptions({ connectionString: explicit }).connectionString).toBe(explicit);
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

// 2026-11-06, dev worker: every old revision logged "Database not opened" while it shut down, because
// the queue-depth gauge kept reading pg-boss after stop(). Stopping the gauge removes its callback.
describe('queue depth gauge (docs/observability.md, Metrics)', () => {
  it('reads the queues at each export, and never after it is stopped', async () => {
    const telemetry = memoryTelemetry();
    try {
      let reads = 0;
      let stopped = false;
      const stop = observeQueueDepth(currentMeter(), async () => {
        reads++;
        if (stopped) throw new Error('Database not opened. Call start() before using pg-boss, or again after stop().');
        return [{ name: 'publishing-tick', queuedCount: 2, activeCount: 1 }];
      });
      expect(await telemetry.points('postly.queue.depth')).toEqual(
        expect.arrayContaining([
          { labels: { queue: 'publishing-tick', state: 'queued' }, value: 2 },
          { labels: { queue: 'publishing-tick', state: 'active' }, value: 1 },
        ]),
      );
      expect(reads).toBe(1);

      stop();
      stopped = true;
      const lines: string[] = [];
      setLogSink((line) => lines.push(line));
      try {
        await telemetry.points('postly.queue.depth');
      } finally {
        setLogSink(undefined);
      }
      expect(reads).toBe(1);
      expect(lines).toEqual([]);
    } finally {
      telemetry.stop();
    }
  });

  it('skips a queue name that is not a code word', async () => {
    const telemetry = memoryTelemetry();
    try {
      observeQueueDepth(currentMeter(), async () => [{ name: 'Bad Name!', queuedCount: 5, activeCount: 0 }]);
      expect(await telemetry.points('postly.queue.depth')).toEqual([]);
    } finally {
      telemetry.stop();
    }
  });
});

// 2026-11-06, dev console: the console started a full pg-boss (queue cache, supervision, cron monitor,
// instance heartbeat) only to send jobs it never sends. On a service whose CPU is throttled between
// requests, those timers' connections timed out. A send-only queue starts pg-boss on its first send.
describe('send-only queue', () => {
  it('starts nothing until the first send, then starts once and sends through it', async () => {
    const sent: unknown[] = [];
    let starts = 0;
    let stops = 0;
    const queue = createSendOnlyQueue(async () => {
      starts++;
      const inner = createMemoryQueue();
      return { ...inner, send: async (name, data, options) => void sent.push({ name, data, options }), stop: async () => void stops++ };
    });
    expect(starts).toBe(0);
    await queue.stop();
    expect(stops).toBe(0);

    await Promise.all([queue.send('inbound-burst', { n: 1 }), queue.send('inbound-burst', { n: 2 }, { singletonKey: 'k' })]);
    expect(starts).toBe(1);
    expect(sent).toEqual([
      { name: 'inbound-burst', data: { n: 1 }, options: undefined },
      { name: 'inbound-burst', data: { n: 2 }, options: { singletonKey: 'k' } },
    ]);
    await queue.stop();
    expect(stops).toBe(1);
  });

  it('retries the start after a failed one, and refuses handlers', async () => {
    let attempt = 0;
    const queue = createSendOnlyQueue(async () => {
      attempt++;
      if (attempt === 1) throw new Error('Connection terminated due to connection timeout');
      return createMemoryQueue();
    });
    await expect(queue.send('x', {})).rejects.toThrow('connection timeout');
    await expect(queue.send('x', {})).rejects.toThrow('no handler for job: x');
    expect(attempt).toBe(2);
    await expect(queue.register('x', async () => {})).rejects.toThrow('send-only');
    await expect(queue.schedule('x', '* * * * *', async () => {})).rejects.toThrow('send-only');
  });

  it('starts pg-boss for sending without supervision or cron', () => {
    expect(pgBossConstructorOptions({ connectionString: 'postgres://app_jobs@db/p', sendOnly: true })).toMatchObject({ supervise: false, schedule: false });
    expect(pgBossConstructorOptions({ connectionString: 'postgres://app_jobs@db/p' })).not.toHaveProperty('supervise');
  });
});

// docs/observability.md, "Following one message": job lifecycle lines, in the payload's correlation.
describe('job lifecycle lines', () => {
  it('logs job started and ended, or failed, with the job and the payload correlationId as labels', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      const queue = await startWorker(createMemoryQueue(), {
        'inbound-burst': async () => {},
        'monthly-report': async () => {
          throw Object.assign(new Error('provider down'), { code: 'E_DOWN' });
        },
      });
      await queue.send('inbound-burst', { businessId: 'b-1', from: '+972501234567', correlationId: 'm-1' });
      await queue.drain();
      await queue.send('monthly-report', null);
      await expect(queue.drain()).rejects.toThrow('provider down');
    } finally {
      setLogSink(undefined);
    }
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.map((l) => [l.severity, l.message, (l['logging.googleapis.com/labels'] as Record<string, string>).jobName])).toEqual([
      ['INFO', 'job started', 'inbound-burst'],
      ['INFO', 'job ended', 'inbound-burst'],
      ['INFO', 'job started', 'monthly-report'],
      ['WARNING', 'job failed', 'monthly-report'],
    ]);
    expect(parsed[0]!['logging.googleapis.com/labels']).toMatchObject({ correlationId: 'm-1', jobId: 'memory-1' });
    expect(parsed[1]).toMatchObject({ durationMs: expect.any(Number) });
    expect(parsed[3]).toMatchObject({ error: 'provider down', errorCode: 'E_DOWN', durationMs: expect.any(Number) });
    expect((parsed[3]!['logging.googleapis.com/labels'] as Record<string, string>).correlationId).toBeUndefined();
    expect(lines.join('\n')).not.toContain('+972501234567');
  });
});
