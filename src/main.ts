import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { createPgBossQueue, createPostgresSimulatorStore, createSendOnlyQueue, provisionDatabase } from './db/index.js';
import { INBOUND_BURST_JOB, type InboundBurstJob, jobBurstWake } from './modules/messaging/index.js';
import { buildConsoleServer } from './console-server.js';
import { ConsoleActionError, createConsole, createIapVerifier, type ConsoleAuth } from './modules/console/index.js';
import { buildServer } from './server.js';
import { createSimulatedApp } from './simulated.js';
import { MemorySimulatorStore } from './simulators/index.js';
import { startWorkerProcess } from './worker.js';
import { asError, log, setLogLabels, setLogLevel } from './shared/logger.js';
import { startTelemetry } from './shared/telemetry-gcp.js';

// The image's entry point (docs/deployment.md): `node dist/src/main.js web|worker|console|migrate`, compiled
// by `npm run build` (tsconfig.build.json). Until the vendor adapters
// land (WP-41) the composition uses the simulators (simulated mode, WP-51), so no run reaches a vendor
// except Gemini, which every deployed environment calls through Vertex AI; stage and prod refuse to
// start (src/config.ts).

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

  const config = loadConfig(process.env, command);
  setLogLevel(config.logLevel);
  // Metrics and traces (docs/observability.md, WP-48): exported only in dev, stage and prod.
  const stopTelemetry = startTelemetry({
    service: command,
    env: config.env,
    exportMode: process.env.TELEMETRY_EXPORT,
    project: process.env.GOOGLE_CLOUD_PROJECT,
    sampleRatio: process.env.TRACE_SAMPLE_RATIO,
  });
  log.info('database pools', { poolMax: config.dbPoolMax, maxConnections: config.maxConnections });
  // Simulated mode (docs/deployment.md, "Simulated mode"): config allows it only in local, test and dev.
  const store = config.simulators.store === 'postgres' ? createPostgresSimulatorStore(config.simulators.storeUrl) : new MemorySimulatorStore();
  // Web and worker connect to pg-boss at start: the web process sends and runs the inbound-burst job
  // (T2), the worker runs every other job. The console runs no job and sends none in practice (no
  // inbound message reaches it), so its pg-boss starts only on a first send, without supervision or
  // cron (2026-11-06: its idle pg-boss timers timed out on a CPU-throttled, scale-to-zero service).
  const queue =
    command === 'console'
      ? createSendOnlyQueue(() => createPgBossQueue({ connectionString: config.jobsUrl, sendOnly: true }))
      : await createPgBossQueue({ connectionString: config.jobsUrl, observeDepth: command === 'worker' });
  const { app, world, db, close } = await createSimulatedApp({
    store,
    burstWake: jobBurstWake(queue),
    burstQuietMs: config.burstQuietMs,
    databaseUrls: config.databaseUrls,
    poolMax: config.dbPoolMax,
    webhookSecret: config.webhookSecret,
    publicBaseUrl: config.publicBaseUrl,
    businessNumber: config.businessNumber,
    ...(process.env.SANDBOX_URL ? { sandboxUrl: process.env.SANDBOX_URL } : {}),
    // Deployed: real Gemini, the other providers still simulated (agent.md, Running on dev).
    ...(config.vertex ? { vertex: config.vertex } : {}),
    // The agents always run: onboarding, weekly and drafts, with no switch (agent.md, Running on dev).
    oneShotFlows: false,
  });
  log.info('composition', { models: config.models, burstQuietMs: config.burstQuietMs, ...(config.vertex ? { vertexLocation: config.vertex.location } : {}) });

  // Deployed processes sit behind Cloud Run's front end, one proxy hop (docs/security.md, D8).
  const deployed = config.env !== 'local' && config.env !== 'test';
  const stops: Array<() => Promise<void> | void> = [];
  if (command === 'web') {
    const server = buildServer({ messaging: app.messaging, ...(app.billing ? { billing: app.billing } : {}), publicBaseUrl: config.publicBaseUrl, ...(deployed ? { trustProxyHops: 1 } : {}) });
    await queue.register<InboundBurstJob>(INBOUND_BURST_JOB, async (job) => void (await app.messaging.processBurst(job.businessId, job.from)), { policy: 'short' });
    stops.push(app.start(), () => server.close(), () => queue.stop());
    await server.listen({ host: '0.0.0.0', port: config.port });
  } else if (command === 'console') {
    // Behind a load balancer with IAP (docs/security.md, "Console exposure"); the dev bypass only locally.
    const c = config.console;
    if (c.auth === 'iap' && !c.iapAudience) log.warn('console sign-in is not configured (CONSOLE_IAP_AUDIENCE); every console request is refused');
    const auth: ConsoleAuth =
      c.auth === 'dev-bypass' ? { mode: 'dev-bypass', actor: c.devActor } : { mode: 'iap', ...(c.iapAudience ? { verifier: createIapVerifier({ audience: c.iapAudience }) } : {}) };
    const server = buildConsoleServer({
      console: createConsole(db, app.workflow),
      // The cancellation keeps its reason; the actor is in the console action log line (WP-46 audit rows later).
      cancelBusiness: (id) => app.cancellation.cancel(id, 'console'),
      auth,
      // security.md, "Media in the console": the bytes come from the app's media store, behind the sign-in.
      readMedia: async (storagePath) => {
        const file = await world.media.read(storagePath);
        if (!file) throw new ConsoleActionError(404, 'not_found');
        return file.data;
      },
      ...(deployed ? { trustProxyHops: 1 } : {}),
      ...(c.auth === 'iap' && c.host ? { allowedHosts: [c.host] } : {}),
    });
    stops.push(() => server.close(), () => queue.stop());
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
  log.error('startup failed', { error: asError(error) });
  process.exit(1);
});
