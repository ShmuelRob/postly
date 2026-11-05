import Fastify, { type FastifyInstance } from 'fastify';
import { trustHops } from './trust-proxy.js';
import { registerBillingRoutes, type Billing } from './modules/billing/index.js';
import { registerMessagingRoutes, type Messaging } from './modules/messaging/index.js';
import { traceFromHeaders, withLogContext } from './shared/logger.js';

export interface ServerOptions {
  messaging: Messaging;
  /** Adds the payment provider's webhook route. */
  billing?: Billing;
  publicBaseUrl: string;
  /**
   * Sweeps inbound messages never processed at startup and then at this interval (technical-design.md,
   * Onboarding flow). Off when unset: the sweep reads every business, so tests that share a database
   * leave it off.
   */
  sweepEveryMs?: number;
  /** Per-process webhook rate limits (docs/security.md, D12); defaults in the routes. */
  limits?: { messagingPerMinute?: number; paymentPerMinute?: number };
  /**
   * Proxy hops in front of the process (docs/security.md, D8): 1 behind Cloud Run's front end, unset
   * locally. Only that many X-Forwarded-For entries are trusted; the IP is never authentication.
   */
  trustProxyHops?: number;
}

/**
 * The web process (technical-design.md): Fastify with the messaging webhook. The composition root
 * that builds real providers from configuration comes with the adapters and deployment (WP-41, WP-44).
 */
export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, ...trustHops(options.trustProxyHops) });
  // One log context per request (docs/observability.md): the request id and the Cloud Trace name.
  app.addHook('onRequest', (request, _reply, done) => {
    withLogContext({ requestId: request.id, trace: traceFromHeaders(request.headers, process.env.GOOGLE_CLOUD_PROJECT) }, done);
  });
  app.get('/healthz', async () => ({ ok: true }));
  registerMessagingRoutes(app, { ...options, ...(options.limits?.messagingPerMinute ? { perMinute: options.limits.messagingPerMinute } : {}) });
  const sweepEveryMs = options.sweepEveryMs;
  if (sweepEveryMs !== undefined) {
    let stop = () => {};
    app.addHook('onReady', async () => {
      stop = options.messaging.startSweep(sweepEveryMs);
    });
    app.addHook('onClose', async () => stop());
  }
  if (options.billing) registerBillingRoutes(app, { billing: options.billing, publicBaseUrl: options.publicBaseUrl, ...(options.limits?.paymentPerMinute ? { perMinute: options.limits.paymentPerMinute } : {}) });
  app.addHook('onClose', () => options.messaging.close());
  return app;
}
