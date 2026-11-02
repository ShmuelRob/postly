import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/db/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * One migrated Postgres for the db project. TEST_DATABASE_URL points at an existing empty database
 * with a superuser login; otherwise Testcontainers starts Postgres in Docker (technical-design.md).
 */
export default async function setup(project: TestProject) {
  let container: StartedPostgreSqlContainer | undefined;
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    url = container.getConnectionUri();
  }
  await runMigrations(url);
  project.provide('databaseUrl', url);
  return async () => {
    await container?.stop();
  };
}
