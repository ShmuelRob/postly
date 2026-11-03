import type { TestProject } from 'vitest/node';
import type { DatabaseUrls } from '../../src/db/index.js';
import { startTestDatabase } from './start-database.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** One login per role in database-schema.md; tests never use the migration superuser. */
    databaseUrls: DatabaseUrls;
  }
}

/** One migrated Postgres for the db and e2e projects (see start-database.ts). */
export default async function setup(project: TestProject) {
  const database = await startTestDatabase();
  project.provide('databaseUrls', database.urls);
  return database.stop;
}
