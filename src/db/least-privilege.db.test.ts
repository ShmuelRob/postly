import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { grants, has, MATRIX_ROLES, type Role, type Verb } from '../../test/db/grant-matrix.js';
import { BUSINESS_ROLES, createDatabase, loginFor, SYSTEM_PURPOSES } from './index.js';
import * as schema from './schema.js';

// Least privilege from database-schema.md: one login per role, each reaching only the tables and
// verbs of the grant matrix, no login a member of another, and only system roles bypassing RLS.

const urls = inject('databaseUrls');
const db = createDatabase(urls, { max: 1 });
afterAll(() => db.close());

const ROLES: Role[] = [...BUSINESS_ROLES, ...SYSTEM_PURPOSES];
const LOGINS = ROLES.map(loginFor);
const VERBS: Verb[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const TABLES = Object.values(schema as Record<string, unknown>)
  .filter((v): v is PgTable => v instanceof PgTable)
  .map((t) => getTableConfig(t));

// Catalog queries run on one role login; has_*_privilege answers about any role.
const catalog = postgres(urls.system.console, { max: 1, onnotice: () => {} });
afterAll(() => catalog.end());

/** Drizzle wraps the Postgres error; its message is in cause. */
async function dbError(run: Promise<unknown>): Promise<string | undefined> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof Error)) return undefined;
  return error.cause instanceof Error ? error.cause.message : error.message;
}

it('the grant matrix fixture matches database-schema.md', () => {
  const doc = readFileSync(new URL('../../docs/database-schema.md', import.meta.url), 'utf8').replaceAll('\r', '');
  const docRows = doc
    .slice(doc.indexOf('| Table | messaging'))
    .split('\n\n')[0]!
    .split('\n')
    .slice(2)
    .map((l) => l.replaceAll('`', ''));
  expect(docRows.length).toBe(grants.size);
  expect(MATRIX_ROLES).toEqual(ROLES);
  for (const line of docRows) expect(grants.has(line.split('|')[1]!.trim())).toBe(true);
});

it('the matrix covers every table in the schema', () => {
  expect([...grants.keys()].sort()).toEqual(TABLES.map((t) => t.name).sort());
});

describe('logins', () => {
  it('exist for every role, and the WP-20 app_user and app_system are gone', async () => {
    const rows = await catalog`select rolname from pg_roles where rolname like 'app\\_%'`;
    expect(rows.map((r) => r.rolname).sort()).toEqual([...LOGINS].sort());
  });

  it('only the system roles bypass RLS, and none is a superuser or can create roles', async () => {
    const rows = await catalog`
      select rolname, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin
      from pg_roles where rolname in ${catalog(LOGINS)}`;
    for (const r of rows) {
      const system = SYSTEM_PURPOSES.some((p) => loginFor(p) === r.rolname);
      expect({ name: r.rolname, bypass: r.rolbypassrls }).toEqual({ name: r.rolname, bypass: system });
      expect([r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin]).toEqual([false, false, false, true]);
    }
  });

  it('are members of no role, and no role is a member of them', async () => {
    const rows = await catalog`
      select m.rolname as member, r.rolname as role from pg_auth_members a
      join pg_roles m on m.oid = a.member join pg_roles r on r.oid = a.roleid
      where m.rolname in ${catalog(LOGINS)} or r.rolname in ${catalog(LOGINS)}`;
    expect(rows).toEqual([]);
  });

  it('own no table', async () => {
    const rows = await catalog`select tablename from pg_tables where schemaname = 'public' and tableowner in ${catalog(LOGINS)}`;
    expect(rows).toEqual([]);
  });

  it('nothing is granted to public on any table', async () => {
    const rows = await catalog`
      select table_name from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'PUBLIC'`;
    expect(rows).toEqual([]);
  });
});

describe.each(ROLES)('%s', (role) => {
  const login = loginFor(role);

  it.each(TABLES.map((t) => t.name))('has exactly its matrix verbs on %s', async (table) => {
    const rows = await catalog`
      select v as verb, has_table_privilege(${login}, ${'public.' + table}, v) as granted
      from unnest(${VERBS}::text[]) as v`;
    const actual = Object.fromEntries(rows.map((r) => [r.verb, r.granted]));
    const expected = Object.fromEntries(VERBS.map((v) => [v, has(table, role, v)]));
    expect(actual).toEqual(expected);

    const columns = TABLES.find((t) => t.name === table)!.columns.map((c) => c.name);
    const updatable = await catalog`
      select c from unnest(${columns}::text[]) as c
      where has_column_privilege(${login}, ${'public.' + table}, c, 'UPDATE')`;
    const grant = grants.get(table)!.get(role)!;
    const expectedColumns = grant.verbs.has('UPDATE') ? columns : grant.updateColumns;
    expect(updatable.map((r) => r.c).sort()).toEqual([...expectedColumns].sort());
  });

  it('is refused a select on every table outside its matrix, and allowed on the rest', async () => {
    const zero = '00000000-0000-4000-8000-000000000000';
    const run = (table: string) =>
      (BUSINESS_ROLES as readonly string[]).includes(role)
        ? db.withBusiness(role as (typeof BUSINESS_ROLES)[number], zero, (tx) => tx.execute(sql`select 1 from ${sql.identifier(table)} limit 1`))
        : db.withSystem(role as (typeof SYSTEM_PURPOSES)[number], (tx) => tx.execute(sql`select 1 from ${sql.identifier(table)} limit 1`));
    for (const { name } of TABLES) {
      const message = await dbError(run(name));
      if (has(name, role, 'SELECT')) expect({ name, message }).toEqual({ name, message: undefined });
      else expect({ name, message }).toEqual({ name, message: `permission denied for table ${name}` });
    }
  });
});

describe('withBusiness and withSystem', () => {
  it('run as the login of the role or purpose they were given', async () => {
    const zero = '00000000-0000-4000-8000-000000000000';
    for (const role of BUSINESS_ROLES) {
      const [row] = await db.withBusiness(role, zero, (tx) => tx.execute(sql`select current_user as u`));
      expect(row).toEqual({ u: loginFor(role) });
    }
    for (const purpose of SYSTEM_PURPOSES) {
      const [row] = await db.withSystem(purpose, (tx) => tx.execute(sql`select current_user as u`));
      expect(row).toEqual({ u: loginFor(purpose) });
    }
  });

  it('reject an unknown role or purpose before connecting', async () => {
    const zero = '00000000-0000-4000-8000-000000000000';
    await expect(db.withBusiness('admin' as never, zero, async () => 1)).rejects.toThrow(/unknown business role/);
    await expect(db.withBusiness('console' as never, zero, async () => 1)).rejects.toThrow(/unknown business role/);
    await expect(db.withSystem('messaging' as never, async () => 1)).rejects.toThrow(/unknown system purpose/);
  });
});
