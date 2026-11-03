import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { BUSINESS_ROLES, type DatabaseUrls, databaseUrls, loginFor, SYSTEM_PURPOSES } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';

const PASSWORD = 'test-only';

export interface TestDatabase {
  /** One login per role in database-schema.md; callers never use the migration superuser. */
  urls: DatabaseUrls;
  stop(): Promise<void>;
}

/**
 * One migrated Postgres for tests and the local playground. TEST_DATABASE_URL points at an existing
 * empty database with a superuser login; otherwise Testcontainers starts Postgres in Docker
 * (technical-design.md). The superuser runs the migrations and sets test passwords on the role logins.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
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
  return {
    urls: databaseUrls(url, () => PASSWORD),
    stop: async () => {
      await container?.stop();
    },
  };
}
