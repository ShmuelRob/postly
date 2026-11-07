import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { setLogSink } from '../../src/shared/logger.js';
import { apiRoute, runApiRoute } from './errors.js';

// 2026-11-06, dev sandbox: GET /api/state answered 500 seventy-three times (an old revision reading
// columns migration 0024 had dropped) and no log line said why. Every unhandled route error is now
// logged with log.error (message, stack, route, request id) before the 500, which carries only the
// request id, never the error text.

let lines: string[] = [];
let server: Server | undefined;
afterEach(async () => {
  setLogSink(undefined);
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

async function serve(route: (res: ServerResponse) => Promise<void>): Promise<string> {
  lines = [];
  setLogSink((line) => lines.push(line));
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://sandbox.local');
    runApiRoute(req, res, url, () => route(res));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('sandbox route errors', () => {
  it('logs a failing route with message, stack, route and request id, and answers 500 with the request id only', async () => {
    const base = await serve(async () => {
      throw Object.assign(new Error('column "agent_flows" does not exist'), { code: '42703' });
    });
    const response = await fetch(`${base}/api/state?from=0501234567`);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; requestId: string };
    expect(body.error).toBe('internal error');
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);

    const errors = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.severity === 'ERROR');
    expect(errors).toHaveLength(1);
    const [line] = errors;
    expect(line).toMatchObject({ message: 'sandbox request failed', route: 'GET /api/state', error: 'column "agent_flows" does not exist', errorCode: '42703' });
    expect((line!['logging.googleapis.com/labels'] as Record<string, string>).requestId).toBe(body.requestId);
    expect(String(line!.stack_trace)).toMatch(/^Error: column "agent_flows" does not exist\n\s+at /);
    expect(JSON.stringify(line)).not.toContain('0501234567');
  });

  it('logs nothing for a route that succeeds', async () => {
    const base = await serve(async (res) => void res.writeHead(200).end('{}'));
    expect((await fetch(`${base}/api/state`)).status).toBe(200);
    expect(lines).toEqual([]);
  });

  it('names a route by its pattern, never by an id in the path', () => {
    expect(apiRoute('POST', '/api/checkout/cus_123-abc')).toBe('POST /api/checkout/:id');
    expect(apiRoute('GET', '/api/media')).toBe('GET /api/media');
    expect(apiRoute(undefined, '/api/whatever/0501234567')).toBe('GET /api/other');
  });
});
