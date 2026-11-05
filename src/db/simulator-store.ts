import postgres from 'postgres';
import type { SimulatorStore, StoredFile } from '../simulators/persistent.js';
import { quoteLiteral } from './sql-literal.js';

// Simulated mode in dev (WP-51, docs/deployment.md "Simulated mode"): the simulators' state and stored
// files in the `simulator` schema, owned by its own login `app_simulator`, which has no grant on any
// business table (like `app_jobs` for pg-boss). Created by the migration job only when
// SIMULATOR_STORE=postgres, so stage and prod have neither the login nor the schema.

export const SIMULATOR_LOGIN = 'app_simulator';
export const SIMULATOR_SCHEMA = 'simulator';

/** The admin statements that create the login and schema; the tables are created as the login. */
export function simulatorProvisionStatements(password: string): string[] {
  return [
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SIMULATOR_LOGIN}') THEN
        CREATE ROLE ${SIMULATOR_LOGIN} LOGIN NOBYPASSRLS NOINHERIT;
      END IF;
    END $$`,
    `ALTER ROLE ${SIMULATOR_LOGIN} LOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOBYPASSRLS`,
    // AUTHORIZATION needs SET ROLE on the login; the Cloud SQL admin is not a superuser (see provision.ts).
    `GRANT ${SIMULATOR_LOGIN} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`,
    `CREATE SCHEMA IF NOT EXISTS ${SIMULATOR_SCHEMA} AUTHORIZATION ${SIMULATOR_LOGIN}`,
    `REVOKE ALL ON SCHEMA public FROM ${SIMULATOR_LOGIN}`,
    `alter role ${SIMULATOR_LOGIN} password ${quoteLiteral(password)}`,
  ];
}

/** Creates the login and schema as the admin, then the tables as the login. */
export async function provisionSimulatorStore(options: { adminUrl: string; password: string }): Promise<void> {
  const admin = postgres(options.adminUrl, { max: 1, onnotice: () => {} });
  try {
    for (const statement of simulatorProvisionStatements(options.password)) await admin.unsafe(statement);
  } finally {
    await admin.end();
  }
  const url = new URL(options.adminUrl);
  url.username = SIMULATOR_LOGIN;
  url.password = options.password;
  const own = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    await own.unsafe(`
      CREATE TABLE IF NOT EXISTS ${SIMULATOR_SCHEMA}.state (
        name text PRIMARY KEY,
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ${SIMULATOR_SCHEMA}.media (
        path text PRIMARY KEY,
        mime_type text NOT NULL,
        data bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );`);
  } finally {
    await own.end();
  }
}

/**
 * The Postgres SimulatorStore. `update` locks the named row (`SELECT ... FOR UPDATE`) for the whole
 * call, so calls from web, worker and the sandbox on the same simulator run one at a time.
 */
export function createPostgresSimulatorStore(url: string, options: { max?: number } = {}): SimulatorStore & { close(): Promise<void> } {
  const sql = postgres(url, { max: options.max ?? 4, onnotice: () => {} });
  const state = sql(`${SIMULATOR_SCHEMA}.state`);
  const media = sql(`${SIMULATOR_SCHEMA}.media`);
  return {
    async update(name, fn) {
      return (await sql.begin(async (tx) => {
        await tx`insert into ${state} (name, state) values (${name}, 'null'::jsonb) on conflict (name) do nothing`;
        const [row] = await tx`select state from ${state} where name = ${name} for update`;
        const current: unknown = row?.state ?? null;
        const { state: next, result } = await fn(current === null ? undefined : current);
        await tx`update ${state} set state = ${tx.json(next as postgres.JSONValue)}, updated_at = now() where name = ${name}`;
        return [result];
      }))[0] as never;
    },
    async putFile(path, data, mimeType) {
      await sql`insert into ${media} (path, mime_type, data) values (${path}, ${mimeType}, ${Buffer.from(data)})
        on conflict (path) do update set mime_type = excluded.mime_type, data = excluded.data`;
    },
    async getFile(path): Promise<StoredFile | undefined> {
      const [row] = await sql`select mime_type, data from ${media} where path = ${path}`;
      return row ? { mimeType: row.mime_type as string, data: new Uint8Array(row.data as Buffer) } : undefined;
    },
    async removeFiles(which) {
      if ('prefix' in which) {
        const pattern = `${which.prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        await sql`delete from ${media} where path like ${pattern}`;
      } else if (which.paths.length > 0) {
        await sql`delete from ${media} where path in ${sql(which.paths)}`;
      }
    },
    close: () => sql.end(),
  };
}
