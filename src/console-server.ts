import Fastify, { type FastifyInstance } from 'fastify';
import { registerConsoleRoutes, type ConsoleRouteOptions } from './modules/console/index.js';

/**
 * The console process (docs/security.md, "Console exposure"): only the console routes and `/healthz`.
 * It runs as its own Cloud Run service behind a load balancer with IAP, because ingress is set per
 * service and the web service must stay public for the provider webhooks. `/healthz` needs no
 * sign-in, so Cloud Run's probes reach it.
 */
export function buildConsoleServer(options: ConsoleRouteOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/healthz', async () => ({ ok: true }));
  registerConsoleRoutes(app, options);
  return app;
}
