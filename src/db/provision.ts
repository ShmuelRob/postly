import postgres from 'postgres';
import { createPgBossQueue } from './jobs.js';
import { ALL_LOGINS, JOBS_LOGIN, JOBS_SCHEMA } from './index.js';
import { runMigrations } from './migrate.js';

// The migration job (docs/deployment.md): one run before each deploy, as the database admin user.
// It applies the Drizzle migrations (which create one login per role in database-schema.md, "Least
// privilege"), sets each login's password from the secret manager, and creates the job queue login
// and its pg-boss schema. Roles and grants live in the migrations; Terraform never creates them.

/** A Postgres string literal; ALTER ROLE ... PASSWORD takes no bind parameters. */
export function quoteLiteral(value: string): string {
  const body = value.replaceAll("'", "''");
  return value.includes('\\') ? `E'${body.replaceAll('\\', '\\\\')}'` : `'${body}'`;
}

export function passwordStatements(passwordFor: (login: string) => string | undefined): string[] {
  return ALL_LOGINS.map((login) => {
    const password = passwordFor(login);
    if (!password) throw new Error(`no password for ${login}`);
    return `alter role ${login} password ${quoteLiteral(password)}`;
  });
}

export interface ProvisionOptions {
  /** The admin user (the Cloud SQL built-in user or a superuser locally); needs CREATEROLE. */
  adminUrl: string;
  passwordFor(login: string): string | undefined;
}

export async function provisionDatabase(options: ProvisionOptions): Promise<void> {
  const statements = passwordStatements(options.passwordFor);
  await runMigrations(options.adminUrl);
  const admin = postgres(options.adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${JOBS_LOGIN}') THEN
          CREATE ROLE ${JOBS_LOGIN} LOGIN NOBYPASSRLS NOINHERIT;
        END IF;
      END $$;
      ALTER ROLE ${JOBS_LOGIN} LOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOBYPASSRLS;
      CREATE SCHEMA IF NOT EXISTS ${JOBS_SCHEMA} AUTHORIZATION ${JOBS_LOGIN};
      REVOKE ALL ON SCHEMA public FROM ${JOBS_LOGIN};`);
    for (const statement of statements) await admin.unsafe(statement);
  } finally {
    await admin.end();
  }
  // pg-boss creates and migrates its own tables, as their owner.
  const url = new URL(options.adminUrl);
  url.username = JOBS_LOGIN;
  url.password = options.passwordFor(JOBS_LOGIN)!;
  const queue = await createPgBossQueue({ connectionString: url.toString(), schema: JOBS_SCHEMA, migrate: true, createSchema: false });
  await queue.stop();
}
