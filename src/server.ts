import Fastify, { type FastifyInstance } from 'fastify';
import { registerMessagingRoutes, type Messaging } from './modules/messaging/index.js';

export interface ServerOptions {
  messaging: Messaging;
  publicBaseUrl: string;
  /**
   * Sweeps inbound messages never processed at startup and then at this interval (technical-design.md,
   * Onboarding flow). Off when unset: the sweep reads every business, so tests that share a database
   * leave it off.
   */
  sweepEveryMs?: number;
}

/**
 * The web process (technical-design.md): Fastify with the messaging webhook. The composition root
 * that builds real providers from configuration comes with the adapters and deployment (WP-41, WP-44).
 */
export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/healthz', async () => ({ ok: true }));
  registerMessagingRoutes(app, options);
  const sweepEveryMs = options.sweepEveryMs;
  if (sweepEveryMs !== undefined) {
    const sweep = () => void options.messaging.sweepUnprocessed().catch((error: unknown) => console.error('inbound sweep failed', error));
    let timer: NodeJS.Timeout | undefined;
    app.addHook('onReady', async () => {
      sweep();
      timer = setInterval(sweep, sweepEveryMs);
    });
    app.addHook('onClose', async () => clearInterval(timer));
  }
  app.addHook('onClose', () => options.messaging.close());
  return app;
}
