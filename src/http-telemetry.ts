import type { FastifyInstance, FastifyRequest } from 'fastify';
import { log, traceFromHeaders, withLogContext } from './shared/logger.js';
import { startHttpSpan, type HttpSpan } from './shared/telemetry.js';

// One log context and one span per request (docs/observability.md, Logging and Tracing), for the web
// and console servers. The span records the route pattern and status, never the URL or the body.
// Fastify's own logger is off, so its default error handler logs nothing: the onError hook logs every
// unhandled route error that becomes a 5xx, before the response (2026-11-06, silent 500s on dev).

const spans = new WeakMap<FastifyRequest, HttpSpan>();

export function observeRequests(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    const span = startHttpSpan(request.headers, request.method);
    spans.set(request, span);
    withLogContext({ requestId: request.id, trace: traceFromHeaders(request.headers, process.env.GOOGLE_CLOUD_PROJECT) }, () => span.run(done));
  });
  app.addHook('onError', (request, reply, error, done) => {
    const statusCode = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : reply.statusCode >= 400 ? reply.statusCode : 500;
    if (statusCode >= 500) {
      withLogContext({ requestId: request.id }, () =>
        log.error('request failed', { method: request.method, route: request.routeOptions.url ?? 'unknown', statusCode, error }),
      );
    }
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    spans.get(request)?.end(request.routeOptions.url, reply.statusCode);
    done();
  });
}
