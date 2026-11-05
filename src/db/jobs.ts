import { PgBoss } from 'pg-boss';
import { withLogContext } from '../shared/logger.js';
import { log } from '../shared/logger.js';

// Background jobs (technical-design.md: pg-boss). pg-boss opens its own connections, so it lives in
// src/db/ with the other drivers. Handlers are registered by name; the queue behind them is an
// interface, so tests run the same registrations in memory.

export type JobHandler<T = unknown> = (data: T) => Promise<void>;

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
}

export async function createPgBossQueue(options: PgBossQueueOptions): Promise<JobQueue> {
  const migrate = options.migrate ?? false;
  const boss = new PgBoss({ connectionString: options.connectionString, schema: options.schema ?? 'pgboss', migrate, createSchema: options.createSchema ?? migrate });
  boss.on('error', (error) => log.error('pg-boss error', { error: String(error) }));
  await boss.start();
  return {
    async register(name, handler, opts) {
      // The policy is fixed when the queue is created; a sender may have created it first.
      if (!(await boss.getQueue(name))) await boss.createQueue(name, opts?.policy ? { policy: opts.policy } : {});
      await boss.work(name, async (jobs) => {
        for (const job of jobs) await withLogContext({ jobId: job.id, jobName: name }, () => handler(job.data as never));
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
        for (const job of jobs) await withLogContext({ jobId: job.id, jobName: name }, () => handler(null));
      });
      await boss.schedule(name, cron, null, { tz: 'UTC' });
    },
    async stop() {
      await boss.stop({ graceful: true });
    },
  };
}

/** An in-process queue for tests and local runs: jobs run when `drain()` is called. */
export function createMemoryQueue(): JobQueue & {
  drain(): Promise<number>;
  schedules(): ScheduledJob[];
  /** Queues one run of a scheduled job, as its cron firing would. */
  fire(name: string): Promise<void>;
} {
  const handlers = new Map<string, JobHandler<never>>();
  const pending: Array<{ name: string; data: unknown }> = [];
  const scheduled: ScheduledJob[] = [];
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
    async fire(name) {
      if (!scheduled.some((s) => s.name === name)) throw new Error(`not scheduled: ${name}`);
      pending.push({ name, data: null });
    },
    async stop() {},
    async drain() {
      let ran = 0;
      for (let job = pending.shift(); job; job = pending.shift()) {
        await withLogContext({ jobId: `memory-${ran + 1}`, jobName: job.name }, () => handlers.get(job.name)!(job.data as never));
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
