import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import postgres from 'postgres';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/db/migrate.js';
import { provisionSimulatorStore } from '../../src/db/simulator-store.js';

// One shared local test Postgres, a database per run (technical-design.md, "Local test database").
// Given a superuser URL to the server, each run gets a fresh database copied from a template that holds the
// migrated schema (`CREATE DATABASE ... TEMPLATE ...`), named after the worktree and a run id, and dropped
// at the end. The template is keyed by a hash of drizzle/, so a branch with other migrations gets its own.
// Roles are global to the server: every template's migrations create the same app_* logins.

/** Run databases older than this are left over from a crashed run and dropped on the next start. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Serializes template builds, copies and clean-ups across every run on the server. */
const SERVER_LOCK = 330_088;
const RUN_PREFIX = 'postly_run_';
const TEMPLATE_PREFIX = 'postly_tpl_';
const READY = 'postly template ready';

/** A hash of every file in the migrations folder, paths and contents (line endings ignored): 12 hex characters. */
export function migrationsHash(folder: string = MIGRATIONS_FOLDER): string {
  const hash = createHash('sha256');
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  for (const file of files(folder).sort()) {
    hash.update(relative(folder, file).split(sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

export const templateName = (hash: string) => `${TEMPLATE_PREFIX}${hash}`;

/** `postly_run_<worktree>_<yyyymmddhhmmss UTC>_<id>`: at most 63 characters, only [a-z0-9_]. */
export function runDatabaseName(worktree: string, now: Date, id: string): string {
  const slug = worktree.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'run';
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${RUN_PREFIX}${slug}_${stamp}_${id}`;
}

/** When a run database was created, from its name; undefined for a name this module did not make. */
export function runDatabaseTime(name: string): Date | undefined {
  const match = /^postly_run_[a-z0-9_]*_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[0-9a-f]{8}$/.exec(name);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!));
}

/** The run databases among `names` that are older than STALE_AFTER_MS at `now`. */
export function staleRunDatabases(names: string[], now: Date): string[] {
  return names.filter((name) => {
    const time = runDatabaseTime(name);
    return time !== undefined && now.getTime() - time.getTime() > STALE_AFTER_MS;
  });
}

/** The URL of database `name` on the server at `serverUrl`, with the same login. */
export function databaseUrl(serverUrl: string, name: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

export interface RunDatabase {
  name: string;
  /** Superuser URL to the run's own database. */
  url: string;
  drop(): Promise<void>;
}

const ident = (name: string) => {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`not a test database name: ${name}`);
  return `"${name}"`;
};

/**
 * Creates this run's database on the shared server, from the template for the current migrations (built
 * first if missing), after dropping run databases older than a day and templates unused for a day. The
 * returned `drop` removes it.
 */
export async function createRunDatabase(
  serverUrl: string,
  options: { worktree?: string; now?: Date; password: string },
): Promise<RunDatabase> {
  const now = options.now ?? new Date();
  const name = runDatabaseName(options.worktree ?? basename(process.cwd()), now, randomBytes(4).toString('hex'));
  const template = templateName(migrationsHash());
  // One connection, so the session-level advisory lock and every statement share it.
  const admin = postgres(serverUrl, { max: 1, onnotice: () => {} });
  try {
    await admin`select pg_advisory_lock(${SERVER_LOCK})`;
    try {
      await dropStale(admin, now, template);
      await ensureTemplate(admin, serverUrl, template, options.password);
      await admin.unsafe(`comment on database ${ident(template)} is '${READY} ${now.toISOString()}'`);
      await admin.unsafe(`create database ${ident(name)} template ${ident(template)}`);
      await copyDatabasePrivileges(admin, template, name);
    } finally {
      await admin`select pg_advisory_unlock(${SERVER_LOCK})`;
    }
  } finally {
    await admin.end();
  }
  return {
    name,
    url: databaseUrl(serverUrl, name),
    drop: async () => {
      const sql = postgres(serverUrl, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(`drop database if exists ${ident(name)} with (force)`);
      } finally {
        await sql.end();
      }
    },
  };
}

async function dropStale(admin: postgres.Sql, now: Date, current: string): Promise<void> {
  const runs = await admin<{ datname: string }[]>`select datname from pg_database where datname like ${RUN_PREFIX + '%'}`;
  for (const name of staleRunDatabases(runs.map((r) => r.datname), now)) {
    await admin.unsafe(`drop database if exists ${ident(name)} with (force)`);
  }
  const templates = await admin<{ datname: string; comment: string | null }[]>`
    select datname, shobj_description(oid, 'pg_database') as comment
    from pg_database where datname like ${TEMPLATE_PREFIX + '%'}`;
  for (const t of templates) {
    if (t.datname === current) continue;
    const used = t.comment?.startsWith(READY) ? new Date(t.comment.slice(READY.length + 1)) : undefined;
    if (!used || Number.isNaN(used.getTime()) || now.getTime() - used.getTime() > STALE_AFTER_MS) {
      await admin.unsafe(`drop database if exists ${ident(t.datname)} with (force)`);
    }
  }
}

/** Builds the template for these migrations unless a finished one exists; a half-built one is rebuilt. */
async function ensureTemplate(admin: postgres.Sql, serverUrl: string, template: string, password: string): Promise<void> {
  const [row] = await admin<{ comment: string | null }[]>`
    select shobj_description(oid, 'pg_database') as comment from pg_database where datname = ${template}`;
  if (row?.comment?.startsWith(READY)) return;
  if (row) await admin.unsafe(`drop database ${ident(template)} with (force)`);
  await admin.unsafe(`create database ${ident(template)}`);
  const url = databaseUrl(serverUrl, template);
  await runMigrations(url);
  await provisionSimulatorStore({ adminUrl: url, password });
}

/**
 * `CREATE DATABASE ... TEMPLATE` copies everything inside the database but not the database's own
 * privileges (pg_database.datacl), so the migrations' REVOKE TEMPORARY ON DATABASE (database-schema.md,
 * "No temporary tables") is copied here: the run database gets exactly the template's privileges.
 */
async function copyDatabasePrivileges(admin: postgres.Sql, template: string, target: string): Promise<void> {
  const grants = await admin<{ grantee: string; privilege: string; grantable: boolean }[]>`
    select case when a.grantee = 0 then 'public' else quote_ident(r.rolname) end as grantee,
           a.privilege_type as privilege, a.is_grantable as grantable
    from pg_database d, aclexplode(d.datacl) a left join pg_roles r on r.oid = a.grantee
    where d.datname = ${template}`;
  const [acl] = await admin<{ isNull: boolean }[]>`select datacl is null as "isNull" from pg_database where datname = ${template}`;
  if (acl?.isNull) return; // The template has the default privileges, and so does the copy.
  await admin.unsafe(`revoke all on database ${ident(target)} from public`);
  for (const g of grants) {
    await admin.unsafe(`grant ${g.privilege} on database ${ident(target)} to ${g.grantee}${g.grantable ? ' with grant option' : ''}`);
  }
}
