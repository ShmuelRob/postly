import Fastify, { type FastifyInstance } from 'fastify';
import { registerConsoleRoutes, type ConsoleRouteOptions } from './modules/console/index.js';

/** Console request bodies above this are refused with 413 (docs/security.md, D12). */
export const CONSOLE_BODY_LIMIT = 64 * 1024;

/**
 * The console process (docs/security.md, "Console exposure"): only the console routes and `/healthz`.
 * It runs as its own Cloud Run service with internal-only ingress, because ingress is set per
 * service and the web service must stay public for the provider webhooks.
 */
export function buildConsoleServer(options: ConsoleRouteOptions & { limits?: { consolePerMinute?: number } }): FastifyInstance {
  // D12: console bodies are small JSON actions.
  const app = Fastify({ logger: false, bodyLimit: CONSOLE_BODY_LIMIT });
  app.get('/healthz', async () => ({ ok: true }));
  registerConsoleRoutes(app, { ...options, ...(options.limits?.consolePerMinute ? { perMinute: options.limits.consolePerMinute } : {}) });
  return app;
}
