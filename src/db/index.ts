import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { z } from 'zod';
import * as schema from './schema.js';

export { createMemoryQueue, createPgBossQueue, startWorker, type JobHandler, type JobQueue, type PgBossQueueOptions, type ScheduledJob } from './jobs.js';
export { passwordStatements, provisionDatabase, quoteLiteral, type ProvisionOptions } from './provision.js';
export { createPostgresSimulatorStore, provisionSimulatorStore, SIMULATOR_LOGIN, SIMULATOR_SCHEMA } from './simulator-store.js';

// The only way into the database from outside src/db/ (see src/modules/README.md). Each role in
// database-schema.md, "Least privilege", is its own login with its own pool, opened on first use.
// No login owns the tables or is a member of another role, so no SQL inside a transaction can
// switch roles, and each role reaches only the tables and verbs it was granted.

type Db = PostgresJsDatabase<typeof schema>;
/** A transaction handle; valid only inside the callback it was passed to. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Business roles: subject to RLS, one per kind of operation. */
export const BUSINESS_ROLES = [
  'messaging',
  'workflow',
  'content',
  'design',
  'approval',
  'publishing',
  'model',
  'billing',
  'business_data',
  'deletion',
] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

/** Why a system-context transaction is needed; each purpose is its own RLS-bypassing role. */
export const SYSTEM_PURPOSES = ['phone_lookup', 'scheduler', 'console', 'example_set'] as const;
export type SystemPurpose = (typeof SYSTEM_PURPOSES)[number];

/** The login name of a business role or system purpose. */
export function loginFor(role: BusinessRole | SystemPurpose): string {
  return (SYSTEM_PURPOSES as readonly string[]).includes(role) ? `app_sys_${role}` : `app_${role}`;
}

/** pg-boss's own login (docs/deployment.md): it owns only the `pgboss` schema and has no grant on any business table. */
export const JOBS_LOGIN = 'app_jobs';
export const JOBS_SCHEMA = 'pgboss';

/** Every login the migration job gives a password: one per role and purpose, plus the job queue's. */
export const ALL_LOGINS: readonly string[] = [...BUSINESS_ROLES.map(loginFor), ...SYSTEM_PURPOSES.map(loginFor), JOBS_LOGIN];

/**
 * The logins each process uses (docs/security.md, D9): a process loads only these passwords and gets
 * URLs for nothing else. The console process runs the console API and the cancellation; its list is
 * proved by `src/modules/console/console.db.test.ts`, which runs every console action with only these
 * logins. Web and worker still load every login until they are narrowed the same way.
 */
export const PROCESS_LOGINS: Record<'web' | 'worker' | 'console', readonly string[]> = {
  web: ALL_LOGINS,
  worker: ALL_LOGINS,
  console: ['app_sys_console', 'app_workflow', 'app_publishing', 'app_billing', 'app_messaging', JOBS_LOGIN],
};

export interface DatabaseUrls {
  /**
   * One connection string per business role, logging in as `loginFor(role)`. A process lists only the
   * logins it uses (PROCESS_LOGINS); using a role with no URL throws.
   */
  business: Partial<Record<BusinessRole, string>>;
  /** One connection string per system purpose, logging in as `loginFor(purpose)`; partial as above. */
  system: Partial<Record<SystemPurpose, string>>;
}

/** The subset of urls for the given logins only. */
export function onlyLogins(urls: DatabaseUrls, logins: readonly string[]): DatabaseUrls {
  const keep = <K extends BusinessRole | SystemPurpose>(m: Partial<Record<K, string>>) =>
    Object.fromEntries(Object.entries(m).filter(([k]) => logins.includes(loginFor(k as K)))) as Partial<Record<K, string>>;
  return { business: keep(urls.business), system: keep(urls.system) };
}

/** Builds DatabaseUrls from one server URL, with each login's password from passwordFor; only `logins` when given. */
export function databaseUrls(serverUrl: string, passwordFor: (login: string) => string, logins: readonly string[] = ALL_LOGINS): DatabaseUrls {
  const as = (role: BusinessRole | SystemPurpose) => {
    const u = new URL(serverUrl);
    u.username = loginFor(role);
    u.password = passwordFor(u.username);
    return u.toString();
  };
  return {
    business: Object.fromEntries(BUSINESS_ROLES.filter((r) => logins.includes(loginFor(r))).map((r) => [r, as(r)])),
    system: Object.fromEntries(SYSTEM_PURPOSES.filter((p) => logins.includes(loginFor(p))).map((p) => [p, as(p)])),
  };
}

export interface Database {
  /** Runs fn in one transaction as the given business role, scoped by RLS to businessId. */
  withBusiness<T>(role: BusinessRole, businessId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Runs fn in one transaction as the system role for purpose, which bypasses RLS. */
  withSystem<T>(purpose: SystemPurpose, fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const BusinessId = z.uuid();

/** Throws unless url logs in as loginFor(role); postgres() would read PG* env vars for a missing one. */
function checkUrl(role: BusinessRole | SystemPurpose, url: string | undefined): void {
  let user: string | undefined;
  try {
    user = url ? decodeURIComponent(new URL(url).username) : undefined;
  } catch {
    user = undefined;
  }
  if (user !== loginFor(role)) throw new Error(`database URL for ${role} must log in as ${loginFor(role)}`);
}

/** Opens nothing until first use; each role and purpose has its own URL, or none in a process that never uses it (database-schema.md, "In code"). */
export function createDatabase(urls: DatabaseUrls, options: { max?: number } = {}): Database {
  // A missing URL is allowed (the process does not use that login) and fails at use; a present one
  // must log in as its own role.
  for (const role of BUSINESS_ROLES) if (urls.business?.[role] !== undefined) checkUrl(role, urls.business[role]);
  for (const purpose of SYSTEM_PURPOSES) if (urls.system?.[purpose] !== undefined) checkUrl(purpose, urls.system[purpose]);
  const urlFor = (role: BusinessRole | SystemPurpose, url: string | undefined): string => {
    if (url === undefined) throw new Error(`database login ${loginFor(role)} is not configured in this process`);
    return url;
  };
  const clients = new Map<string, postgres.Sql>();
  const dbs = new Map<string, Db>();
  const open = (url: string): Db => {
    let db = dbs.get(url);
    if (!db) {
      const client = postgres(url, { max: options.max ?? 3, onnotice: () => {} });
      clients.set(url, client);
      db = drizzle(client, { schema });
      dbs.set(url, db);
    }
    return db;
  };

  return {
    async withBusiness(role, businessId, fn) {
      if (!BUSINESS_ROLES.includes(role)) throw new Error(`unknown business role: ${String(role)}`);
      const id = BusinessId.parse(businessId);
      return open(urlFor(role, urls.business[role])).transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.business_id', ${id}, true)`);
        return fn(tx);
      });
    },
    async withSystem(purpose, fn) {
      if (!SYSTEM_PURPOSES.includes(purpose)) throw new Error(`unknown system purpose: ${String(purpose)}`);
      return open(urlFor(purpose, urls.system[purpose])).transaction((tx) => fn(tx));
    },
    async close() {
      await Promise.all([...clients.values()].map((c) => c.end()));
      clients.clear();
      dbs.clear();
    },
  };
}
