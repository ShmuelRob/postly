import { startTestDatabase } from '../../test/db/start-database.js';
import { createPlayground, type Playground } from './playground.js';

/** A migrated local Postgres (Testcontainers, or TEST_DATABASE_URL) and the playground on it. */
export async function startLocalPlayground(): Promise<Playground> {
  console.log('[playground] starting Postgres (Docker, or TEST_DATABASE_URL)...');
  const database = await startTestDatabase();
  const playground = await createPlayground({ databaseUrls: database.urls, burstQuietMs: 1500 });
  console.log('[playground] ready');
  return {
    ...playground,
    close: async () => {
      await playground.close();
      await database.stop();
    },
  };
}
