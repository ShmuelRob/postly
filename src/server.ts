import Fastify, { type FastifyInstance } from 'fastify';
import { registerMessagingRoutes, type Messaging } from './modules/messaging/index.js';

export interface ServerOptions {
  messaging: Messaging;
  publicBaseUrl: string;
}

/**
 * The web process (technical-design.md): Fastify with the messaging webhook. The composition root
 * that builds real providers from configuration comes with the adapters and deployment (WP-41, WP-44).
 */
export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/healthz', async () => ({ ok: true }));
  registerMessagingRoutes(app, options);
  app.addHook('onClose', () => options.messaging.close());
  return app;
}
