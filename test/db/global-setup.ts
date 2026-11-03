import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import { BUSINESS_ROLES, type DatabaseUrls, databaseUrls, loginFor, SYSTEM_PURPOSES } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** One login per role in database-schema.md; tests never use the migration superuser. */
    databaseUrls: DatabaseUrls;
  }
}

const PASSWORD = 'test-only';

/**
 * One migrated Postgres for the db project. TEST_DATABASE_URL points at an existing empty database
 * with a superuser login; otherwise Testcontainers starts Postgres in Docker (technical-design.md).
 * The superuser runs the migrations and sets test passwords on the role logins.
 */
export default async function setup(project: TestProject) {
  let container: StartedPostgreSqlContainer | undefined;
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    url = container.getConnectionUri();
  }
  await runMigrations(url);
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    for (const role of [...BUSINESS_ROLES, ...SYSTEM_PURPOSES]) {
      await admin.unsafe(`alter role ${loginFor(role)} password '${PASSWORD}'`);
    }
  } finally {
    await admin.end();
  }
  project.provide('databaseUrls', databaseUrls(url, () => PASSWORD));
  return async () => {
    await container?.stop();
  };
}
