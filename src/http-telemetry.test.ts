import { DrizzleQueryError } from 'drizzle-orm/errors';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { observeRequests } from './http-telemetry.js';
import { setLogSink } from './shared/logger.js';

// 2026-11-06, dev: routes answered 500 with no application log line saying why. Fastify's own logger
// is off (docs/observability.md, Logging), so its default error handler logged nothing. Every
// unhandled route error is now logged before the 500, with the route and the request id.

let lines: string[] = [];
afterEach(() => setLogSink(undefined));
const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

function app() {
  lines = [];
  setLogSink((line) => lines.push(line));
  const server = Fastify({ logger: false });
  observeRequests(server);
  server.get('/api/state/:id', async () => {
    throw Object.assign(new Error('column "agent_flows" does not exist'), { code: '42703' });
  });
  server.get('/bad', async (_request, reply) => reply.code(400).send({ error: 'bad request' }));
  server.get('/teapot', async () => {
    throw Object.assign(new Error('not found here'), { statusCode: 404 });
  });
  return server;
}

describe('route errors (web and console)', () => {
  it('logs an unhandled route error with its message, code, stack, route and request id before the 500', async () => {
    const server = app();
    const response = await server.inject({ method: 'GET', url: '/api/state/123e4567-e89b-12d3-a456-426614174000?phone=0501234567' });
    expect(response.statusCode).toBe(500);
    const errors = parsed().filter((l) => l.severity === 'ERROR');
    expect(errors).toHaveLength(1);
    const [line] = errors;
    expect(line).toMatchObject({
      message: 'request failed',
      method: 'GET',
      route: '/api/state/:id',
      statusCode: 500,
      error: 'column "agent_flows" does not exist',
      errorCode: '42703',
    });
    expect((line!['logging.googleapis.com/labels'] as Record<string, string>).requestId).toMatch(/^req-/);
    expect(String(line!.stack_trace)).toMatch(/^Error: column "agent_flows" does not exist\n\s+at /);
    // The route pattern, never the URL with its query.
    expect(JSON.stringify(line)).not.toContain('0501234567');
    await server.close();
  });

  it('does not log a client error as an ERROR', async () => {
    const server = app();
    expect((await server.inject({ method: 'GET', url: '/bad' })).statusCode).toBe(400);
    expect((await server.inject({ method: 'GET', url: '/teapot' })).statusCode).toBe(404);
    expect(parsed().filter((l) => l.severity === 'ERROR')).toEqual([]);
    await server.close();
  });
});

// Review of PR #136: a failing query on the webhook route must not put the owner's text in the log.
describe('a failing query on a route', () => {
  it('logs the SQL and the parameter count, never the parameters', async () => {
    const text = 'מבצע 1+1 על כל הקרואסונים רק השבוע';
    lines = [];
    setLogSink((line) => lines.push(line));
    const server = Fastify({ logger: false });
    observeRequests(server);
    server.post('/webhooks/whatsapp', async () => {
      throw new DrizzleQueryError('insert into "message" ("body") values ($1)', [text], new Error('connection terminated'));
    });
    expect((await server.inject({ method: 'POST', url: '/webhooks/whatsapp', payload: { text } })).statusCode).toBe(500);
    const [line] = parsed().filter((l) => l.severity === 'ERROR');
    expect(line).toMatchObject({ route: '/webhooks/whatsapp', error: 'Failed query: insert into "message" ("body") values ($1) (1 params)', errorCause: 'Error: connection terminated' });
    expect(lines.join(' ')).not.toContain(text);
    await server.close();
  });
});
