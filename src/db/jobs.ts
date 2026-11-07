import { PgBoss } from 'pg-boss';
import type { Meter } from '@opentelemetry/api';
import { asError, log, withLogContext } from '../shared/logger.js';
import { currentMeter, metrics, withSpan } from '../shared/telemetry.js';

// Background jobs (technical-design.md: pg-boss). pg-boss opens its own connections, so it lives in
// src/db/ with the other drivers. Handlers are registered by name; the queue behind them is an
// interface, so tests run the same registrations in memory.

export type JobHandler<T = unknown> = (data: T) => Promise<void>;

/** One job run: its log context, its span, and its duration and failure metrics (docs/observability.md). */
export async function runJob(name: string, jobId: string, run: () => Promise<void>): Promise<void> {
  await withLogContext({ jobId, jobName: name }, () =>
    withSpan(`job ${name}`, { job: name, jobId }, async () => {
      const started = performance.now();
      try {
        await run();
        metrics.record('postly.jobs.duration', performance.now() - started, { job: name, outcome: 'ok' });
      } catch (error) {
        metrics.record('postly.jobs.duration', performance.now() - started, { job: name, outcome: 'failed' });
        metrics.count('postly.jobs.failures.count', { job: name });
        throw error;
      }
    }),
  );
}

export interface JobQueue {
  /** `policy: 'short'` keeps at most one waiting job per `singletonKey` (the inbound-burst job). */
  register<T>(name: string, handler: JobHandler<T>, options?: { policy?: 'standard' | 'short' }): Promise<void>;
  /** With `singletonKey` on a `short` queue, a send while a job of that key waits is dropped. */
  send<T>(name: string, data: T, options?: { startAfter?: Date; singletonKey?: string }): Promise<void>;
  /**
   * Registers `handler` for `name` and runs it on a cron (UTC). The queue has pg-boss's singleton
   * policy: at most one job of that name is active at a time across every worker instance, and
   * pg-boss creates each cron job once however many instances run. A failed run is retried.
   */
  schedule(name: string, cron: string, handler: JobHandler<null>): Promise<void>;
  /** Removes the cron of a job no worker runs any more, so pg-boss stops creating its jobs. A name never scheduled is a no-op. */
  unschedule(name: string): Promise<void>;
  stop(): Promise<void>;
}

export interface ScheduledJob {
  name: string;
  cron: string;
  singleton: boolean;
}

export interface PgBossQueueOptions {
  connectionString: string;
  /** Defaults to `pgboss`. */
  schema?: string;
  /**
   * Whether pg-boss creates and migrates its schema itself. Off by default: migrations need human
   * review (CLAUDE.md), so the job schema is expected to exist already.
   */
  migrate?: boolean;
  /** With `migrate`, whether pg-boss also creates its schema (default: same as `migrate`). The migration job creates it first, owned by the job login. */
  createSchema?: boolean;
  /** Reports `postly.queue.depth` (the worker only, so the series is not doubled by web). */
  observeDepth?: boolean;
  /**
   * A process that only sends jobs (the console): no supervision (maintenance) and no cron monitor,
   * which the worker and web run. pg-boss still keeps its queue cache and instance heartbeat.
   */
  sendOnly?: boolean;
}

/** pg-boss's own pool in every process, on the `app_jobs` login; the connection budget counts it (docs/security.md, D7). */
export const JOBS_POOL = 10;

/**
 * pg (under pg-boss) reads `sslmode=require` as verify-full, unlike postgres.js and libpq, and the Cloud
 * SQL server certificate is signed by Cloud SQL's own CA: the connection then fails to verify. With
 * `uselibpqcompat=true`, `require` means what it says everywhere else: encrypted, no CA check (the
 * traffic stays on the private VPC to an instance that accepts TLS only).
 */
export function libpqSslMode(connectionString: string): string {
  if (!/[?&]sslmode=require(&|$)/.test(connectionString) || /[?&]uselibpqcompat=/.test(connectionString)) return connectionString;
  return `${connectionString}&uselibpqcompat=true`;
}

/** The PgBoss constructor options, with its pool capped at JOBS_POOL. */
export function pgBossConstructorOptions(options: PgBossQueueOptions) {
  const migrate = options.migrate ?? false;
  return {
    connectionString: libpqSslMode(options.connectionString),
    schema: options.schema ?? 'pgboss',
    migrate,
    createSchema: options.createSchema ?? migrate,
    max: JOBS_POOL,
    ...(options.sendOnly ? { supervise: false, schedule: false } : {}),
  };
}

export interface QueueStats {
  name: string;
  queuedCount: number;
  activeCount: number;
}

/**
 * `postly.queue.depth` (docs/observability.md, Metrics), read at each export. Returns the function
 * that removes the callback: the queue calls it before pg-boss stops, so no export after stop() reads
 * a closed database (2026-11-06, "Database not opened" while old worker revisions shut down).
 */
export function observeQueueDepth(meter: Meter | undefined, readQueues: () => Promise<QueueStats[]>): () => void {
  const gauge = meter?.createObservableGauge('postly.queue.depth', { description: 'pg-boss jobs waiting or running' });
  if (!gauge) return () => {};
  let stopped = false;
  const callback = async (result: { observe(value: number, labels: Record<string, string>): void }) => {
    if (stopped) return;
    try {
      for (const q of await readQueues()) {
        if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(q.name)) continue;
        result.observe(q.queuedCount, { queue: q.name, state: 'queued' });
        result.observe(q.activeCount, { queue: q.name, state: 'active' });
      }
    } catch (error) {
      if (!stopped) log.warn('queue depth not read', { error: asError(error) });
    }
  };
  gauge.addCallback(callback);
  return () => {
    stopped = true;
    gauge.removeCallback(callback);
  };
}

export async function createPgBossQueue(options: PgBossQueueOptions): Promise<JobQueue> {
  const boss = new PgBoss(pgBossConstructorOptions(options));
  // pg-boss emits some failures as plain objects (`{ ...error, message, stack, queue }`), which
  // String() logged as "[object Object]" (2026-11-06); asError keeps their message, code and stack.
  boss.on('error', (error: unknown) => log.error('pg-boss error', { error: asError(error) }));
  await boss.start();
  // Queue depth (docs/observability.md, Metrics), read from pg-boss at each export, until stop().
  const stopDepth = options.observeDepth ? observeQueueDepth(currentMeter(), () => boss.getQueues()) : () => {};
  return {
    async register(name, handler, opts) {
      // The policy is fixed when the queue is created; a sender may have created it first.
      if (!(await boss.getQueue(name))) await boss.createQueue(name, opts?.policy ? { policy: opts.policy } : {});
      await boss.work(name, async (jobs) => {
        for (const job of jobs) await runJob(name, job.id, () => handler(job.data as never));
      });
    },
    async send(name, data, opts) {
      // A keyed send may come before any instance registered the handler: create the short queue.
      if (opts?.singletonKey && !(await boss.getQueue(name))) await boss.createQueue(name, { policy: 'short' });
      await boss.send(name, data as object, {
        ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}),
        ...(opts?.singletonKey ? { singletonKey: opts.singletonKey } : {}),
      });
    },
    async schedule(name, cron, handler) {
      // The policy is fixed when the queue is created, so a scheduled queue is created here.
      if (!(await boss.getQueue(name))) await boss.createQueue(name, { policy: 'singleton', retryLimit: 3 });
      await boss.work(name, async (jobs) => {
        for (const job of jobs) await runJob(name, job.id, () => handler(null));
      });
      await boss.schedule(name, cron, null, { tz: 'UTC' });
    },
    async unschedule(name) {
      await boss.unschedule(name);
    },
    async stop() {
      stopDepth();
      await boss.stop({ graceful: true });
    },
  };
}

/**
 * A queue for a process that only sends jobs (the console): pg-boss starts on the first send, once,
 * and a start that fails is tried again on the next send. Until then the process holds no pg-boss
 * connection and runs none of its timers. Registering a handler is refused.
 */
export function createSendOnlyQueue(start: () => Promise<JobQueue>): JobQueue {
  let started: Promise<JobQueue> | undefined;
  const queue = () => {
    started ??= start().catch((error: unknown) => {
      started = undefined;
      throw error;
    });
    return started;
  };
  const refuse = async () => {
    throw new Error('this queue is send-only: handlers run in the worker and web processes');
  };
  return {
    register: refuse,
    schedule: refuse,
    async send(name, data, options) {
      await (await queue()).send(name, data, options);
    },
    async stop() {
      const current = started;
      started = undefined;
      if (current) await (await current.catch(() => undefined))?.stop();
    },
  };
}

/** An in-process queue for tests and local runs: jobs run when `drain()` is called. */
export function createMemoryQueue(): JobQueue & {
  drain(): Promise<number>;
  schedules(): ScheduledJob[];
  /** Names passed to `unschedule`, in order. */
  unscheduled(): string[];
  /** Queues one run of a scheduled job, as its cron firing would. */
  fire(name: string): Promise<void>;
} {
  const handlers = new Map<string, JobHandler<never>>();
  const pending: Array<{ name: string; data: unknown }> = [];
  const scheduled: ScheduledJob[] = [];
  const removed: string[] = [];
  return {
    async register(name, handler) {
      if (handlers.has(name)) throw new Error(`job already registered: ${name}`);
      handlers.set(name, handler as JobHandler<never>);
    },
    async send(name, data) {
      if (!handlers.has(name)) throw new Error(`no handler for job: ${name}`);
      pending.push({ name, data });
    },
    async schedule(name, cron, handler) {
      await this.register(name, handler);
      scheduled.push({ name, cron, singleton: true });
    },
    schedules: () => [...scheduled],
    async unschedule(name) {
      removed.push(name);
      const at = scheduled.findIndex((s) => s.name === name);
      if (at >= 0) scheduled.splice(at, 1);
    },
    unscheduled: () => [...removed],
    async fire(name) {
      if (!scheduled.some((s) => s.name === name)) throw new Error(`not scheduled: ${name}`);
      pending.push({ name, data: null });
    },
    async stop() {},
    async drain() {
      let ran = 0;
      for (let job = pending.shift(); job; job = pending.shift()) {
        await runJob(job.name, `memory-${ran + 1}`, () => handlers.get(job.name)!(job.data as never));
        ran++;
      }
      return ran;
    },
  };
}

/** Registers every handler on the queue; the worker process entry point calls this once at start. */
export async function startWorker<Q extends JobQueue>(queue: Q, handlers: Record<string, JobHandler<never>>): Promise<Q> {
  for (const [name, handler] of Object.entries(handlers)) await queue.register(name, handler);
  return queue;
}
