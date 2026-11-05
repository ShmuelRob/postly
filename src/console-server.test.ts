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

  describe('CSRF and DNS rebinding (D3, WP-80)', () => {
    const post = (server: ReturnType<typeof buildConsoleServer>, headers: Record<string, string>) =>
      server.inject({ method: 'POST', url: '/console/api/system/resume', remoteAddress: '127.0.0.1', headers, payload: JSON.stringify({ by: 'team' }) });

    it('refuses a Host that is not a loopback name locally (DNS rebinding)', async () => {
      const server = buildConsoleServer({ console: stubConsole, access: 'loopback' });
      const res = await server.inject({ method: 'GET', url: '/console/api/businesses', remoteAddress: '127.0.0.1', headers: { host: 'evil.example:4000' } });
      expect(res.statusCode).toBe(403);
      for (const host of ['localhost:4000', '127.0.0.1:4000', '[::1]:4000', 'localhost']) {
        const ok = await server.inject({ method: 'GET', url: '/console/api/businesses', remoteAddress: '127.0.0.1', headers: { host } });
        expect(ok.statusCode, host).toBe(200);
      }
      await server.close();
    });

    it('deployed, accepts only the configured hosts when they are set', async () => {
      const server = buildConsoleServer({ console: stubConsole, access: 'private-ingress', allowedHosts: ['console.internal'] });
      expect((await server.inject({ method: 'GET', url: '/console/api/businesses', headers: { host: 'console.internal' } })).statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: '/console/api/businesses', headers: { host: 'other.example' } })).statusCode).toBe(403);
      await server.close();
    });

    it('refuses a POST without a JSON content type', async () => {
      const server = buildConsoleServer({ console: stubConsole, access: 'loopback' });
      expect((await post(server, { host: 'localhost:4000', 'content-type': 'text/plain' })).statusCode).toBe(415);
      await server.close();
    });

    it('refuses a POST from another origin and accepts the same origin', async () => {
      const server = buildConsoleServer({ console: stubConsole, access: 'loopback' });
      const json = { host: 'localhost:4000', 'content-type': 'application/json' };
      expect((await post(server, { ...json, origin: 'https://evil.example' })).statusCode).toBe(403);
      expect((await post(server, { ...json, origin: 'null' })).statusCode).toBe(403);
      expect((await post(server, { ...json, origin: 'http://localhost:4000' })).statusCode).toBe(200);
      expect((await post(server, json)).statusCode).toBe(200);
      await server.close();
    });
  });
});
