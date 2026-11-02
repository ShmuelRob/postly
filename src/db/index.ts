import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { z } from 'zod';
import * as schema from './schema.js';

// The only way into the database from outside src/db/ (see src/modules/README.md). Each role in
// database-schema.md, "Tenant isolation", is its own login with its own pool: withBusiness() runs
// as app_user with app.business_id set, withSystem() as app_system. Neither login owns the tables
// or is a member of the other role, so no SQL inside a transaction can switch roles.

type Db = PostgresJsDatabase<typeof schema>;
/** A transaction handle; valid only inside the callback it was passed to. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Why a system-context transaction is needed; only the uses database-schema.md allows. */
export type SystemPurpose = 'phone_lookup' | 'scheduler' | 'console' | 'example_set';

export interface DatabaseUrls {
  /** Login as app_user (subject to RLS). */
  businessUrl: string;
  /** Login as app_system (bypasses RLS). */
  systemUrl: string;
}

export interface Database {
  /** Runs fn in one transaction as app_user, scoped by RLS to businessId. */
  withBusiness<T>(businessId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Runs fn in one transaction as app_system, which bypasses RLS. */
  withSystem<T>(purpose: SystemPurpose, fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const BusinessId = z.uuid();
const PURPOSES: readonly SystemPurpose[] = ['phone_lookup', 'scheduler', 'console', 'example_set'];

export function createDatabase(urls: DatabaseUrls, options: { max?: number } = {}): Database {
  const connect = (url: string) => postgres(url, { max: options.max ?? 10, onnotice: () => {} });
  const businessClient = connect(urls.businessUrl);
  const systemClient = connect(urls.systemUrl);
  const businessDb = drizzle(businessClient, { schema });
  const systemDb = drizzle(systemClient, { schema });

  return {
    async withBusiness(businessId, fn) {
      const id = BusinessId.parse(businessId);
      return businessDb.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.business_id', ${id}, true)`);
        return fn(tx);
      });
    },
    async withSystem(purpose, fn) {
      if (!PURPOSES.includes(purpose)) throw new Error(`unknown system purpose: ${String(purpose)}`);
      return systemDb.transaction((tx) => fn(tx));
    },
    async close() {
      await Promise.all([businessClient.end(), systemClient.end()]);
    },
  };
}
