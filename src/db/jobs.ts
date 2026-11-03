import { PgBoss } from 'pg-boss';

// Background jobs (technical-design.md: pg-boss). pg-boss opens its own connections, so it lives in
// src/db/ with the other drivers. Handlers are registered by name; the queue behind them is an
// interface, so tests run the same registrations in memory.

export type JobHandler<T = unknown> = (data: T) => Promise<void>;

export interface JobQueue {
  register<T>(name: string, handler: JobHandler<T>): Promise<void>;
  send<T>(name: string, data: T, options?: { startAfter?: Date }): Promise<void>;
  stop(): Promise<void>;
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
}

export async function createPgBossQueue(options: PgBossQueueOptions): Promise<JobQueue> {
  const migrate = options.migrate ?? false;
  const boss = new PgBoss({ connectionString: options.connectionString, schema: options.schema ?? 'pgboss', migrate, createSchema: migrate });
  boss.on('error', (error) => console.error(JSON.stringify({ level: 'error', msg: 'pg-boss error', error: String(error) })));
  await boss.start();
  return {
    async register(name, handler) {
      await boss.createQueue(name);
      await boss.work(name, async (jobs) => {
        for (const job of jobs) await handler(job.data as never);
      });
    },
    async send(name, data, opts) {
      await boss.send(name, data as object, opts?.startAfter ? { startAfter: opts.startAfter } : {});
    },
    async stop() {
      await boss.stop({ graceful: true });
    },
  };
}

/** An in-process queue for tests and local runs: jobs run when `drain()` is called. */
export function createMemoryQueue(): JobQueue & { drain(): Promise<number> } {
  const handlers = new Map<string, JobHandler<never>>();
  const pending: Array<{ name: string; data: unknown }> = [];
  return {
    async register(name, handler) {
      if (handlers.has(name)) throw new Error(`job already registered: ${name}`);
      handlers.set(name, handler as JobHandler<never>);
    },
    async send(name, data) {
      if (!handlers.has(name)) throw new Error(`no handler for job: ${name}`);
      pending.push({ name, data });
    },
    async stop() {},
    async drain() {
      let ran = 0;
      for (let job = pending.shift(); job; job = pending.shift()) {
        await handlers.get(job.name)!(job.data as never);
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
