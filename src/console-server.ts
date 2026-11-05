import Fastify, { type FastifyInstance } from 'fastify';
import { trustHops } from './trust-proxy.js';
import { registerConsoleRoutes, type ConsoleRouteOptions } from './modules/console/index.js';
import { observeRequests } from './http-telemetry.js';

/**
 * The console process (docs/security.md, "Console exposure"): only the console routes and `/healthz`.
 * It runs as its own Cloud Run service with internal-only ingress, because ingress is set per
 * service and the web service must stay public for the provider webhooks.
 */
export function buildConsoleServer(options: ConsoleRouteOptions & { trustProxyHops?: number }): FastifyInstance {
  // Cloud Run's front end is one hop (docs/security.md, D8); unset locally.
  const app = Fastify({ logger: false, ...trustHops(options.trustProxyHops) });
  observeRequests(app);
  app.get('/healthz', async () => ({ ok: true }));
  registerConsoleRoutes(app, options);
  return app;
}
