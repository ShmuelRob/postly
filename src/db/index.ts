import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { z } from 'zod';
import * as schema from './schema.js';

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
] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

/** Why a system-context transaction is needed; each purpose is its own RLS-bypassing role. */
export const SYSTEM_PURPOSES = ['phone_lookup', 'scheduler', 'console', 'example_set'] as const;
export type SystemPurpose = (typeof SYSTEM_PURPOSES)[number];

/** The login name of a business role or system purpose. */
export function loginFor(role: BusinessRole | SystemPurpose): string {
  return (SYSTEM_PURPOSES as readonly string[]).includes(role) ? `app_sys_${role}` : `app_${role}`;
}

export interface DatabaseUrls {
  /** One connection string per business role, logging in as `loginFor(role)`. */
  business: Record<BusinessRole, string>;
  /** One connection string per system purpose, logging in as `loginFor(purpose)`. */
  system: Record<SystemPurpose, string>;
}

/** Builds DatabaseUrls from one server URL, with each login's password from passwordFor. */
export function databaseUrls(serverUrl: string, passwordFor: (login: string) => string): DatabaseUrls {
  const as = (role: BusinessRole | SystemPurpose) => {
    const u = new URL(serverUrl);
    u.username = loginFor(role);
    u.password = passwordFor(u.username);
    return u.toString();
  };
  return {
    business: Object.fromEntries(BUSINESS_ROLES.map((r) => [r, as(r)])) as Record<BusinessRole, string>,
    system: Object.fromEntries(SYSTEM_PURPOSES.map((p) => [p, as(p)])) as Record<SystemPurpose, string>,
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

export function createDatabase(urls: DatabaseUrls, options: { max?: number } = {}): Database {
  const clients = new Map<string, postgres.Sql>();
  const dbs = new Map<string, Db>();
  const open = (url: string): Db => {
    let db = dbs.get(url);
    if (!db) {
      const client = postgres(url, { max: options.max ?? 10, onnotice: () => {} });
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
      return open(urls.business[role]).transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.business_id', ${id}, true)`);
        return fn(tx);
      });
    },
    async withSystem(purpose, fn) {
      if (!SYSTEM_PURPOSES.includes(purpose)) throw new Error(`unknown system purpose: ${String(purpose)}`);
      return open(urls.system[purpose]).transaction((tx) => fn(tx));
    },
    async close() {
      await Promise.all([...clients.values()].map((c) => c.end()));
      clients.clear();
      dbs.clear();
    },
  };
}
