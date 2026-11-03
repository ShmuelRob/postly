import Fastify from 'fastify';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase, createPgBossQueue, provisionDatabase } from './db/index.js';
import { createDesignRenderer } from './modules/design/index.js';
import type { MediaStorage } from './modules/messaging/index.js';
import { buildServer } from './server.js';
import { MessagingSimulator, ModelSimulator, PublishingSimulator } from './simulators/index.js';
import { startWorkerProcess } from './worker.js';

// The image's entry point (docs/deployment.md): `node src/main.ts web|worker|migrate`. Node runs the
// TypeScript directly (type stripping), so the image has no build step. Until the vendor adapters
// land (WP-41) the composition uses the simulators, so a local or staging run reaches no vendor.

/** In-process media for simulator runs; the Cloud Storage adapter comes with WP-41. */
function memoryMedia(publicBaseUrl: string): MediaStorage & { get(url: string): Uint8Array | undefined } {
  const files = new Map<string, Uint8Array>();
  const base = `${publicBaseUrl}/media/`;
  return {
    async put(path, bytes) {
      files.set(path, bytes);
    },
    urlFor: (path) => base + path,
    get: (url) => (url.startsWith(base) ? files.get(url.slice(base.length)) : undefined),
  };
}

async function main(command: string | undefined) {
  if (command === 'migrate') {
    const adminUrl = process.env.MIGRATE_ADMIN_URL;
    if (!adminUrl) throw new Error('MIGRATE_ADMIN_URL is required for migrate');
    await provisionDatabase({ adminUrl, passwordFor: (login) => process.env[`DB_PASSWORD_${login.toUpperCase()}`] });
    console.log(JSON.stringify({ level: 'info', msg: 'migrations applied and logins provisioned' }));
    return;
  }
  if (command !== 'web' && command !== 'worker') throw new Error('usage: node src/main.ts web|worker|migrate');

  const config = loadConfig(process.env);
  const db = createDatabase(config.databaseUrls);
  const media = memoryMedia(config.publicBaseUrl);
  const design = createDesignRenderer({
    assets: {
      load: async (url) => {
        const file = media.get(url);
        if (!file) throw new Error(`no stored file at ${url}`);
        return file;
      },
    },
    store: { put: (path, bytes, mimeType) => media.put(path, bytes, mimeType) },
  });
  const app = createApp({
    db,
    providers: { messaging: new MessagingSimulator(), publishing: new PublishingSimulator(), models: { google: new ModelSimulator() } },
    design,
    media,
    businessNumber: config.businessNumber,
    samplePhotoUrl: media.urlFor('bundled/sample.png'),
  });

  const stops: Array<() => Promise<void> | void> = [];
  if (command === 'web') {
    const server = buildServer({ messaging: app.messaging, publicBaseUrl: config.publicBaseUrl });
    stops.push(app.start(), () => server.close());
    await server.listen({ host: '0.0.0.0', port: config.port });
  } else {
    const queue = await startWorkerProcess({ queue: await createPgBossQueue({ connectionString: config.jobsUrl }), weekly: app.weekly });
    // Cloud Run services need a port to probe; the worker serves only its health check.
    const health = Fastify({ logger: false });
    health.get('/healthz', async () => ({ ok: true }));
    stops.push(() => health.close(), () => queue.stop());
    await health.listen({ host: '0.0.0.0', port: config.port });
  }
  console.log(JSON.stringify({ level: 'info', msg: `${command} started` }));

  // Cloud Run sends SIGTERM and allows 10 seconds before SIGKILL.
  process.once('SIGTERM', async () => {
    for (const stop of stops) await stop();
    await db.close();
    process.exit(0);
  });
}

main(process.argv[2]).catch((error: unknown) => {
  console.error(JSON.stringify({ level: 'error', msg: 'startup failed', error: String(error) }));
  process.exit(1);
});
