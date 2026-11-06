import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { asError, log, traceFromHeaders, withLogContext } from '../../src/shared/logger.js';

// The sandbox's API routes in one log context per request, with every unhandled route error logged
// before the 500 (2026-11-06: GET /api/state answered 500 seventy-three times on dev with no log line
// saying why). The 500 carries only the request id, so the error text stays in the scrubbed log.

const ROUTES = ['/api/state', '/api/messages', '/api/sign-up', '/api/connect', '/api/media'];

/** The route pattern for a log line: never an id or anything else from the path or query. */
export function apiRoute(method: string | undefined, pathname: string): string {
  const pattern = ROUTES.includes(pathname) ? pathname : /^\/api\/checkout\/[\w-]+$/.test(pathname) ? '/api/checkout/:id' : '/api/other';
  return `${method ?? 'GET'} ${pattern}`;
}

export function runApiRoute(req: IncomingMessage, res: ServerResponse, url: URL, route: () => Promise<void>): void {
  const requestId = randomUUID();
  const trace = traceFromHeaders(req.headers, process.env.GOOGLE_CLOUD_PROJECT);
  withLogContext({ requestId, trace }, () => {
    route().catch((error: unknown) => {
      log.error('sandbox request failed', { route: apiRoute(req.method, url.pathname), error: asError(error) });
      if (res.headersSent) return void res.end();
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error', requestId }));
    });
  });
}
