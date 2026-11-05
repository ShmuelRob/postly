import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { createPgBossQueue, createPostgresSimulatorStore, provisionDatabase } from './db/index.js';
import { INBOUND_BURST_JOB, type InboundBurstJob, jobBurstWake } from './modules/messaging/index.js';
import { buildConsoleServer } from './console-server.js';
import { createConsole } from './modules/console/index.js';
import { buildServer } from './server.js';
import { createSimulatedApp } from './simulated.js';
import { MemorySimulatorStore } from './simulators/index.js';
import { startWorkerProcess } from './worker.js';
import { log, setLogLabels } from './shared/logger.js';
import { startTelemetry } from './shared/telemetry-gcp.js';

// The image's entry point (docs/deployment.md): `node dist/src/main.js web|worker|console|migrate`, compiled
// by `npm run build` (tsconfig.build.json). Until the vendor adapters
// land (WP-41) the composition uses the simulators (simulated mode, WP-51), so no run reaches a vendor;
// stage and prod refuse to start (src/config.ts).

async function main(command: string | undefined) {
  setLogLabels({ process: command ?? 'unknown' });
  if (command === 'migrate') {
    const adminUrl = process.env.MIGRATE_ADMIN_URL;
    if (!adminUrl) throw new Error('MIGRATE_ADMIN_URL is required for migrate');
    await provisionDatabase({
      adminUrl,
      passwordFor: (login) => process.env[`DB_PASSWORD_${login.toUpperCase()}`],
      // Simulated mode in dev (WP-51): the simulators' schema and login.
      simulatorStore: process.env.SIMULATOR_STORE === 'postgres',
    });
    log.info('migrations applied and logins provisioned');
    return;
  }
  if (command !== 'web' && command !== 'worker' && command !== 'console') throw new Error('usage: node dist/src/main.js web|worker|console|migrate');

  const config = loadConfig(process.env);
  // Metrics and traces (docs/observability.md, WP-48): exported only in dev, stage and prod.
  const stopTelemetry = startTelemetry({
    service: command,
    env: config.env,
    exportMode: process.env.TELEMETRY_EXPORT,
    project: process.env.GOOGLE_CLOUD_PROJECT,
    sampleRatio: process.env.TRACE_SAMPLE_RATIO,
  });
  // Simulated mode (docs/deployment.md, "Simulated mode"): config allows it only in local, test and dev.
  const store = config.simulators.store === 'postgres' ? createPostgresSimulatorStore(config.simulators.storeUrl) : new MemorySimulatorStore();
  // Both processes connect to pg-boss: the web process sends and runs the inbound-burst job (T2).
  const queue = await createPgBossQueue({ connectionString: config.jobsUrl, observeDepth: command === 'worker' });
  const { app, db, close } = await createSimulatedApp({
    store,
    burstWake: jobBurstWake(queue),
    databaseUrls: config.databaseUrls,
    webhookSecret: config.webhookSecret,
    publicBaseUrl: config.publicBaseUrl,
    businessNumber: config.businessNumber,
    ...(process.env.SANDBOX_URL ? { sandboxUrl: process.env.SANDBOX_URL } : {}),
  });

  // Deployed processes sit behind Cloud Run's front end, one proxy hop (docs/security.md, D8).
  const deployed = config.env !== 'local' && config.env !== 'test';
  const stops: Array<() => Promise<void> | void> = [];
  if (command === 'web') {
    const server = buildServer({ messaging: app.messaging, ...(app.billing ? { billing: app.billing } : {}), publicBaseUrl: config.publicBaseUrl, ...(deployed ? { trustProxyHops: 1 } : {}) });
    await queue.register<InboundBurstJob>(INBOUND_BURST_JOB, async (job) => void (await app.messaging.processBurst(job.businessId, job.from)), { policy: 'short' });
    stops.push(app.start(), () => server.close(), () => queue.stop());
    await server.listen({ host: '0.0.0.0', port: config.port });
  } else if (command === 'console') {
    // Its own internal-only service (docs/security.md): deployed, the gate is the ingress and IAM.
    const access = deployed ? 'private-ingress' : 'loopback';
    const server = buildConsoleServer({ console: createConsole(db, app.workflow), cancelBusiness: (id) => app.cancellation.cancel(id, 'console'), access, ...(deployed ? { trustProxyHops: 1 } : {}) });
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
    await close();
    if ('close' in store) await store.close();
    await stopTelemetry();
    process.exit(0);
  });
}

main(process.argv[2]).catch((error: unknown) => {
  log.error('startup failed', { error: String(error) });
  process.exit(1);
});
