import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { BUSINESS_ROLES, type DatabaseUrls, databaseUrls, loginFor, SYSTEM_PURPOSES } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { provisionSimulatorStore, SIMULATOR_LOGIN } from '../../src/db/simulator-store.js';
import { createRunDatabase } from './shared-server.js';

const PASSWORD = 'test-only';

export interface TestDatabase {
  /** One login per role in database-schema.md; callers never use the migration superuser. */
  urls: DatabaseUrls;
  /** The `app_simulator` login's URL: the simulated-mode store (WP-51). */
  simulatorStoreUrl: string;
  stop(): Promise<void>;
}

/**
 * One migrated Postgres for tests and the local playground (technical-design.md, Test database), in one of
 * three modes:
 * - `serverUrl`, or TEST_PG_SERVER_URL: a superuser URL to a shared server (`npm run test:pg`). The caller
 *   gets a fresh database of its own, copied from the migrated template and dropped by `stop`
 *   (technical-design.md, "Local test database"). `worktree` names it; the default is the working folder.
 * - TEST_DATABASE_URL: an existing empty database with a superuser login; the migrations run in it.
 * - Otherwise Testcontainers starts Postgres in Docker, as CI does.
 * With `isolated`, Testcontainers starts a Postgres for the caller alone, whatever is set: for a test whose
 * businesses or global state the other files must not see, or a branch that changes role attributes.
 * The superuser runs the migrations and sets test passwords on the role logins.
 */
export async function startTestDatabase(options: { isolated?: boolean; serverUrl?: string; worktree?: string } = {}): Promise<TestDatabase> {
  const serverUrl = options.isolated ? undefined : (options.serverUrl ?? process.env.TEST_PG_SERVER_URL);
  if (serverUrl) {
    const run = await createRunDatabase(serverUrl, { password: PASSWORD, ...(options.worktree ? { worktree: options.worktree } : {}) });
    // Roles are global to the server; set the test password in case another tool changed it.
    await setPasswords(run.url);
    return { ...connect(run.url), stop: run.drop };
  }
  let container: StartedPostgreSqlContainer | undefined;
  // `isolated`: always a Postgres of its own, for a test whose businesses or global state the other files
  // must not see, such as the sandbox sign-up in sandbox-agent-flows.e2e.test.ts. Needs Docker.
  let url = options.isolated ? undefined : process.env.TEST_DATABASE_URL;
  if (!url) {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    url = container.getConnectionUri();
  }
  await runMigrations(url);
  await setPasswords(url);
  await provisionSimulatorStore({ adminUrl: url, password: PASSWORD });
  return {
    ...connect(url),
    stop: async () => {
      await container?.stop();
    },
  };
}

async function setPasswords(url: string): Promise<void> {
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    for (const role of [...BUSINESS_ROLES, ...SYSTEM_PURPOSES]) {
      await admin.unsafe(`alter role ${loginFor(role)} password '${PASSWORD}'`);
    }
  } finally {
    await admin.end();
  }
}

function connect(url: string): Omit<TestDatabase, 'stop'> {
  const simulatorStoreUrl = new URL(url);
  simulatorStoreUrl.username = SIMULATOR_LOGIN;
  simulatorStoreUrl.password = PASSWORD;
  return { urls: databaseUrls(url, () => PASSWORD), simulatorStoreUrl: simulatorStoreUrl.toString() };
}
