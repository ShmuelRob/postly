import type { FastifyInstance } from 'fastify';
import { InvalidWebhookSignatureError } from '../../contracts/providers/messaging.js';
import type { Billing } from './billing.js';

export const PAYMENT_WEBHOOK_PATH = '/webhooks/payment';

export interface BillingRouteOptions {
  billing: Billing;
  /** The public origin the provider signs against (behind Cloud Run the request host is not it). */
  publicBaseUrl: string;
}

/** POST /webhooks/payment: verified before anything is read or stored. */
export function registerBillingRoutes(app: FastifyInstance, options: BillingRouteOptions): void {
  const url = new URL(PAYMENT_WEBHOOK_PATH, options.publicBaseUrl).toString();
  app.register(async (scope) => {
    // The signature covers the exact bytes, so the body stays a string.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    scope.post(PAYMENT_WEBHOOK_PATH, async (request, reply) => {
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
