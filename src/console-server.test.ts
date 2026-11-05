import { describe, expect, it } from 'vitest';
import type { ConsoleService } from './modules/console/index.js';
import { buildConsoleServer } from './console-server.js';
import { buildServer } from './server.js';
import type { Messaging } from './modules/messaging/index.js';

// The console runs as its own process and Cloud Run service with internal-only ingress
// (docs/security.md, "Console exposure"); the public web service never serves it.

const stubConsole = new Proxy({}, { get: () => async () => [] }) as unknown as ConsoleService;
const stubMessaging = new Proxy({}, { get: () => async () => {} }) as unknown as Messaging;

describe('console process', () => {
  it('the public web server has no console routes', async () => {
    const web = buildServer({ messaging: stubMessaging, publicBaseUrl: 'http://localhost' });
    const res = await web.inject({ method: 'GET', url: '/console/api/businesses', remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(404);
    await web.close();
  });

  it('serves /healthz and the console API', async () => {
    const server = buildConsoleServer({ console: stubConsole, access: 'loopback' });
    expect((await server.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const res = await server.inject({ method: 'GET', url: '/console/api/businesses', remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it('with loopback access, refuses any other address', async () => {
    const server = buildConsoleServer({ console: stubConsole, access: 'loopback' });
    const res = await server.inject({ method: 'GET', url: '/console/api/businesses', remoteAddress: '10.0.0.5' });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('with private-ingress access, leaves the gate to the internal-only service and its IAM', async () => {
    const server = buildConsoleServer({ console: stubConsole, access: 'private-ingress' });
    const res = await server.inject({ method: 'GET', url: '/console/api/businesses', remoteAddress: '10.0.0.5' });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it('serves nothing but the console and /healthz', async () => {
    const server = buildConsoleServer({ console: stubConsole, access: 'private-ingress' });
    expect((await server.inject({ method: 'POST', url: '/webhooks/messaging' })).statusCode).toBe(404);
    await server.close();
  });

  it('cancel needs the business name typed as confirmation (D2, WP-83)', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const cancelled: string[] = [];
    const named = new Proxy({}, { get: (_t, key) => async () => (key === 'businesses' ? [{ id, name: 'מאפיית רחל' }] : []) }) as unknown as ConsoleService;
    const server = buildConsoleServer({ console: named, access: 'loopback', cancelBusiness: async (b) => cancelled.push(b) });
    const cancel = (payload?: object) => server.inject({ method: 'POST', url: `/console/api/businesses/${id}/cancel`, remoteAddress: '127.0.0.1', ...(payload ? { payload } : {}) });
    expect((await cancel()).statusCode).toBe(400);
    expect((await cancel({ confirmName: 'מאפיה אחרת' })).statusCode).toBe(400);
    expect(cancelled).toEqual([]);
    const unknown = await server.inject({ method: 'POST', url: '/console/api/businesses/00000000-0000-4000-8000-000000000002/cancel', remoteAddress: '127.0.0.1', payload: { confirmName: 'מאפיית רחל' } });
    expect(unknown.statusCode).toBe(404);
    expect((await cancel({ confirmName: ' מאפיית רחל ' })).statusCode).toBe(200);
    expect(cancelled).toEqual([id]);
    await server.close();
  });
});
