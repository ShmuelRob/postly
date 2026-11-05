import type { FastifyInstance } from 'fastify';
import { FixedWindowLimiter, rateLimitHook } from '../../shared/rate-limit.js';
import { InvalidWebhookSignatureError } from '../../contracts/providers/messaging.js';
import type { Billing } from './billing.js';

export const PAYMENT_WEBHOOK_PATH = '/webhooks/payment';

/** Webhook bodies above this are refused with 413 before verification (D12). */
export const WEBHOOK_BODY_LIMIT = 256 * 1024;

export interface BillingRouteOptions {
  billing: Billing;
  /** The public origin the provider signs against (behind Cloud Run the request host is not it). */
  publicBaseUrl: string;
  /** Requests admitted per minute in this process before 429 (docs/security.md, D12). */
  perMinute?: number;
}

/** POST /webhooks/payment: verified before anything is read or stored. */
export function registerBillingRoutes(app: FastifyInstance, options: BillingRouteOptions): void {
  const url = new URL(PAYMENT_WEBHOOK_PATH, options.publicBaseUrl).toString();
  const limiter = new FixedWindowLimiter({ limit: options.perMinute ?? 120 });
  app.register(async (scope) => {
    // D12: the limit and the body size are checked before the signature is.
    scope.addHook('onRequest', rateLimitHook(limiter));
    // The signature covers the exact bytes, so the body stays a string.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    scope.post(PAYMENT_WEBHOOK_PATH, { bodyLimit: WEBHOOK_BODY_LIMIT }, async (request, reply) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(request.headers)) {
        if (typeof v === 'string') headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(', ');
      }
      try {
        const outcome = await options.billing.handleWebhook({ headers, body: String(request.body ?? ''), url });
        return reply.code(200).send({ outcome: outcome.kind });
      } catch (error) {
        if (error instanceof InvalidWebhookSignatureError) return reply.code(401).send({ error: 'invalid signature' });
        throw error;
      }
    });
  });
}
