import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { createPgBossQueue, createPostgresSimulatorStore, provisionDatabase } from './db/index.js';
import { buildConsoleServer } from './console-server.js';
import { createConsole } from './modules/console/index.js';
import { buildServer } from './server.js';
import { createSimulatedApp } from './simulated.js';
import { MemorySimulatorStore } from './simulators/index.js';
import { startWorkerProcess } from './worker.js';

// The image's entry point (docs/deployment.md): `node dist/src/main.js web|worker|console|migrate`, compiled
// by `npm run build` (tsconfig.build.json). Until the vendor adapters
// land (WP-41) the composition uses the simulators (simulated mode, WP-51), so no run reaches a vendor;
// stage and prod refuse to start (src/config.ts).

async function main(command: string | undefined) {
  if (command === 'migrate') {
    const adminUrl = process.env.MIGRATE_ADMIN_URL;
    if (!adminUrl) throw new Error('MIGRATE_ADMIN_URL is required for migrate');
    await provisionDatabase({
      adminUrl,
      passwordFor: (login) => process.env[`DB_PASSWORD_${login.toUpperCase()}`],
      // Simulated mode in dev (WP-51): the simulators' schema and login.
      simulatorStore: process.env.SIMULATOR_STORE === 'postgres',
    });
    console.log(JSON.stringify({ level: 'info', msg: 'migrations applied and logins provisioned' }));
    return;
  }
  if (command !== 'web' && command !== 'worker' && command !== 'console') throw new Error('usage: node dist/src/main.js web|worker|console|migrate');

  const config = loadConfig(process.env);
  // Simulated mode (docs/deployment.md, "Simulated mode"): config allows it only in local, test and dev.
  const store = config.simulators.store === 'postgres' ? createPostgresSimulatorStore(config.simulators.storeUrl) : new MemorySimulatorStore();
  const { app, db, close } = await createSimulatedApp({
    store,
    databaseUrls: config.databaseUrls,
    webhookSecret: config.webhookSecret,
    publicBaseUrl: config.publicBaseUrl,
    businessNumber: config.businessNumber,
    ...(process.env.SANDBOX_URL ? { sandboxUrl: process.env.SANDBOX_URL } : {}),
  });

  const stops: Array<() => Promise<void> | void> = [];
  if (command === 'web') {
    const server = buildServer({ messaging: app.messaging, ...(app.billing ? { billing: app.billing } : {}), publicBaseUrl: config.publicBaseUrl });
    stops.push(app.start(), () => server.close());
    await server.listen({ host: '0.0.0.0', port: config.port });
  } else if (command === 'console') {
    // Its own internal-only service (docs/security.md): deployed, the gate is the ingress and IAM.
    const access = config.env === 'local' || config.env === 'test' ? 'loopback' : 'private-ingress';
    const server = buildConsoleServer({ console: createConsole(db, app.workflow), cancelBusiness: (id) => app.cancellation.cancel(id, 'console'), access });
    stops.push(() => server.close());
    await server.listen({ host: '0.0.0.0', port: config.port });
  } else {
    const queue = await startWorkerProcess({ queue: await createPgBossQueue({ connectionString: config.jobsUrl }), weekly: app.weekly, publishing: app.publishing, channelHealth: app.channelHealth, dataDeletion: app.dataDeletion, monthlyReport: app.monthlyReport });
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
    await close();
    if ('close' in store) await store.close();
    process.exit(0);
  });
}

main(process.argv[2]).catch((error: unknown) => {
  console.error(JSON.stringify({ level: 'error', msg: 'startup failed', error: String(error) }));
  process.exit(1);
});
