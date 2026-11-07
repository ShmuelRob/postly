import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { BUSINESS_ROLES, type DatabaseUrls, databaseUrls, loginFor, SYSTEM_PURPOSES } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { provisionSimulatorStore, SIMULATOR_LOGIN } from '../../src/db/simulator-store.js';

const PASSWORD = 'test-only';

export interface TestDatabase {
  /** One login per role in database-schema.md; callers never use the migration superuser. */
  urls: DatabaseUrls;
  /** The `app_simulator` login's URL: the simulated-mode store (WP-51). */
  simulatorStoreUrl: string;
  stop(): Promise<void>;
}

/**
 * One migrated Postgres for tests and the local playground. TEST_DATABASE_URL points at an existing
 * empty database with a superuser login; otherwise Testcontainers starts Postgres in Docker
 * (technical-design.md). The superuser runs the migrations and sets test passwords on the role logins.
 * With `isolated`, Testcontainers starts a Postgres for the caller alone, even with TEST_DATABASE_URL set.
 */
export async function startTestDatabase(options: { isolated?: boolean } = {}): Promise<TestDatabase> {
  let container: StartedPostgreSqlContainer | undefined;
  // `isolated`: always a Postgres of its own, for a test whose businesses or global state the other files
  // must not see, such as the sandbox sign-up in sandbox-agent-flows.e2e.test.ts. Needs Docker.
  let url = options.isolated ? undefined : process.env.TEST_DATABASE_URL;
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
  await provisionSimulatorStore({ adminUrl: url, password: PASSWORD });
  const simulatorStoreUrl = new URL(url);
  simulatorStoreUrl.username = SIMULATOR_LOGIN;
  simulatorStoreUrl.password = PASSWORD;
  return {
    urls: databaseUrls(url, () => PASSWORD),
    simulatorStoreUrl: simulatorStoreUrl.toString(),
    stop: async () => {
      await container?.stop();
    },
  };
}
