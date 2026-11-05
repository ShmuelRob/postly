import Fastify from 'fastify';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase, createPgBossQueue, provisionDatabase } from './db/index.js';
import { createDesignRenderer } from './modules/design/index.js';
import type { DeletionStorage } from './modules/business-data/index.js';
import { INBOUND_BURST_JOB, type InboundBurstJob, jobBurstWake, type MediaStorage } from './modules/messaging/index.js';
import { buildConsoleServer } from './console-server.js';
import { createConsole } from './modules/console/index.js';
import { buildServer } from './server.js';
import { MessagingSimulator, ModelSimulator, PaymentSimulator, PublishingSimulator } from './simulators/index.js';
import { startWorkerProcess } from './worker.js';
import { log, setLogLabels } from './shared/logger.js';

// The image's entry point (docs/deployment.md): `node dist/src/main.js web|worker|console|migrate`, compiled
// by `npm run build` (tsconfig.build.json). Until the vendor adapters
// land (WP-41) the composition uses the simulators, so a local or stage run reaches no vendor.

/** In-process media for simulator runs; the Cloud Storage adapter comes with WP-41. */
function memoryMedia(publicBaseUrl: string): MediaStorage & DeletionStorage & { get(url: string): Uint8Array | undefined; read(path: string): Promise<{ data: Uint8Array } | undefined> } {
  const files = new Map<string, Uint8Array>();
  const base = `${publicBaseUrl}/media/`;
  return {
    async put(path, bytes) {
      files.set(path, bytes);
    },
    urlFor: (path) => base + path,
    // Data deletion after cancellation (WP-43).
    async removePrefix(prefix) {
      for (const path of [...files.keys()]) if (path.startsWith(prefix)) files.delete(path);
    },
    async remove(paths) {
      for (const path of paths) files.delete(path);
    },
    get: (url) => (url.startsWith(base) ? files.get(url.slice(base.length)) : undefined),
    // Drafting (WP-32) reads rendered files back by storage path to record their SHA-256.
    read: async (path) => {
      const data = files.get(path);
      return data ? { data } : undefined;
    },
  };
}

async function main(command: string | undefined) {
  setLogLabels({ process: command ?? 'unknown' });
  if (command === 'migrate') {
    const adminUrl = process.env.MIGRATE_ADMIN_URL;
    if (!adminUrl) throw new Error('MIGRATE_ADMIN_URL is required for migrate');
    await provisionDatabase({ adminUrl, passwordFor: (login) => process.env[`DB_PASSWORD_${login.toUpperCase()}`] });
    log.info('migrations applied and logins provisioned');
    return;
  }
  if (command !== 'web' && command !== 'worker' && command !== 'console') throw new Error('usage: node dist/src/main.js web|worker|console|migrate');

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
  // Both processes connect to pg-boss: the web process sends and runs the inbound-burst job (T2).
  const queue = await createPgBossQueue({ connectionString: config.jobsUrl });
  const app = createApp({
    db,
    burstWake: jobBurstWake(queue),
    providers: { messaging: new MessagingSimulator({ webhookSecret: config.webhookSecret }), publishing: new PublishingSimulator(), models: { google: new ModelSimulator() }, payment: new PaymentSimulator() },
    design,
    media,
    businessNumber: config.businessNumber,
    samplePhotoUrl: media.urlFor('bundled/sample.png'),
  });

  const stops: Array<() => Promise<void> | void> = [];
  if (command === 'web') {
    const server = buildServer({ messaging: app.messaging, ...(app.billing ? { billing: app.billing } : {}), publicBaseUrl: config.publicBaseUrl });
    await queue.register<InboundBurstJob>(INBOUND_BURST_JOB, async (job) => void (await app.messaging.processBurst(job.businessId, job.from)), { policy: 'short' });
    stops.push(app.start(), () => server.close(), () => queue.stop());
    await server.listen({ host: '0.0.0.0', port: config.port });
  } else if (command === 'console') {
    // Its own internal-only service (docs/security.md): deployed, the gate is the ingress and IAM.
    const access = config.env === 'local' || config.env === 'test' ? 'loopback' : 'private-ingress';
    const server = buildConsoleServer({ console: createConsole(db, app.workflow), cancelBusiness: (id) => app.cancellation.cancel(id, 'console'), access });
    stops.push(() => server.close());
    await server.listen({ host: '0.0.0.0', port: config.port });
  } else {
    await startWorkerProcess({ queue, weekly: app.weekly, publishing: app.publishing, channelHealth: app.channelHealth, dataDeletion: app.dataDeletion, monthlyReport: app.monthlyReport, ...(app.billingHold ? { billingHold: app.billingHold } : {}) });
    // Cloud Run services need a port to probe; the worker serves only its health check.
    const health = Fastify({ logger: false });
    health.get('/healthz', async () => ({ ok: true }));
    stops.push(() => health.close(), () => queue.stop());
    await health.listen({ host: '0.0.0.0', port: config.port });
  }
  log.info(`${command} started`);

  // Cloud Run sends SIGTERM and allows 10 seconds before SIGKILL.
  process.once('SIGTERM', async () => {
    for (const stop of stops) await stop();
    await db.close();
    process.exit(0);
  });
}

main(process.argv[2]).catch((error: unknown) => {
  log.error('startup failed', { error: String(error) });
  process.exit(1);
});
