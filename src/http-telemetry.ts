import type { FastifyInstance, FastifyRequest } from 'fastify';
import { traceFromHeaders, withLogContext } from './shared/logger.js';
import { startHttpSpan, type HttpSpan } from './shared/telemetry.js';

// One log context and one span per request (docs/observability.md, Logging and Tracing), for the web
// and console servers. The span records the route pattern and status, never the URL or the body.

const spans = new WeakMap<FastifyRequest, HttpSpan>();

export function observeRequests(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    const span = startHttpSpan(request.headers, request.method);
    spans.set(request, span);
    withLogContext({ requestId: request.id, trace: traceFromHeaders(request.headers, process.env.GOOGLE_CLOUD_PROJECT) }, () => span.run(done));
  });
  app.addHook('onResponse', (request, reply, done) => {
    spans.get(request)?.end(request.routeOptions.url, reply.statusCode);
    done();
  });
}
