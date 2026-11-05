import type { FastifyInstance } from 'fastify';
import { InvalidWebhookSignatureError } from '../../contracts/providers/messaging.js';
import type { Messaging } from './messaging.js';

export const WEBHOOK_PATH = '/webhooks/messaging';

/** Webhook bodies above this are refused with 413 before verification (D12). */
export const WEBHOOK_BODY_LIMIT = 256 * 1024;

export interface MessagingRouteOptions {
  messaging: Messaging;
  /** The public origin the vendor signs against (behind Cloud Run the request host is not it). */
  publicBaseUrl: string;
}

/** POST /webhooks/messaging: verified before anything is stored (technical-design.md, Security). */
export function registerMessagingRoutes(app: FastifyInstance, options: MessagingRouteOptions): void {
  const url = new URL(WEBHOOK_PATH, options.publicBaseUrl).toString();
  app.register(async (scope) => {
    // D12: the body size is checked before the signature. No rate limit here: a counter before the
    // signature check would let unsigned floods refuse genuine events; floods are for Cloud Armor.
    // The signature covers the exact bytes, so the body stays a string.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    scope.post(WEBHOOK_PATH, { bodyLimit: WEBHOOK_BODY_LIMIT }, async (request, reply) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(request.headers)) {
        if (typeof v === 'string') headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(', ');
      }
      try {
        const outcomes = await options.messaging.handleWebhook({ headers, body: String(request.body ?? ''), url });
        return reply.code(200).send({ outcomes });
      } catch (error) {
        if (error instanceof InvalidWebhookSignatureError) return reply.code(401).send({ error: 'invalid signature' });
        throw error;
      }
    });
  });
}
