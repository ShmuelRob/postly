import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ConsoleService } from './modules/console/index.js';
import { buildConsoleServer } from './console-server.js';
import { buildServer } from './server.js';
import { createIapVerifier, IAP_HEADER } from './modules/console/index.js';
import { createTestIap, TEST_IAP_AUDIENCE } from '../test/e2e/harness/iap.js';
import type { Messaging } from './modules/messaging/index.js';

// The console runs as its own process and Cloud Run service behind a load balancer with IAP
// (docs/security.md, "Console exposure"); the public web service never serves it.

const stubConsole = new Proxy({}, { get: () => async () => [] }) as unknown as ConsoleService;
const iap = createTestIap();
const verifier = createIapVerifier({ audience: TEST_IAP_AUDIENCE, fetchKeys: async () => iap.keys });

const stubMessaging = new Proxy({}, { get: () => async () => {} }) as unknown as Messaging;

describe('console process', () => {
  it('the public web server has no console routes', async () => {
    const web = buildServer({ messaging: stubMessaging, publicBaseUrl: 'http://localhost' });
    const res = await web.inject({ method: 'GET', url: '/console/api/businesses', remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(404);
    await web.close();
  });

  it('serves /healthz and the console API', async () => {
    const server = buildConsoleServer({ console: stubConsole });
    expect((await server.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const res = await server.inject({ method: 'GET', url: '/console/api/businesses', remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it('with the dev bypass, refuses any address but loopback', async () => {
    const server = buildConsoleServer({ console: stubConsole, auth: { mode: 'dev-bypass' } });
    const res = await server.inject({ method: 'GET', url: '/console/api/businesses', remoteAddress: '10.0.0.5' });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('serves nothing but the console and /healthz', async () => {
    const server = buildConsoleServer({ console: stubConsole, auth: { mode: 'iap', verifier } });
    expect((await server.inject({ method: 'POST', url: '/webhooks/messaging' })).statusCode).toBe(404);
    await server.close();
  });

  it('cancel needs the business name typed as confirmation (D2, WP-83)', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const cancelled: string[] = [];
    const named = new Proxy({}, { get: (_t, key) => async () => (key === 'businesses' ? [{ id, name: 'מאפיית רחל' }] : []) }) as unknown as ConsoleService;
    const server = buildConsoleServer({ console: named, auth: { mode: 'dev-bypass' }, cancelBusiness: async (b) => cancelled.push(b) });
    const cancel = (payload?: object) => server.inject({ method: 'POST', url: `/console/api/businesses/${id}/cancel`, remoteAddress: '127.0.0.1', ...(payload ? { payload } : {}) });
    expect((await cancel({})).statusCode).toBe(400);
    expect((await cancel({ confirmName: 'מאפיה אחרת' })).statusCode).toBe(400);
    expect(cancelled).toEqual([]);
    const unknown = await server.inject({ method: 'POST', url: '/console/api/businesses/00000000-0000-4000-8000-000000000002/cancel', remoteAddress: '127.0.0.1', payload: { confirmName: 'מאפיית רחל' } });
    expect(unknown.statusCode).toBe(404);
    expect((await cancel({ confirmName: ' מאפיית רחל ' })).statusCode).toBe(200);
    expect(cancelled).toEqual([id]);
    await server.close();
  });

  describe('CSRF and DNS rebinding (D3, WP-80)', () => {
    const post = (server: ReturnType<typeof buildConsoleServer>, headers: Record<string, string>) =>
      server.inject({ method: 'POST', url: '/console/api/system/resume', remoteAddress: '127.0.0.1', headers, payload: JSON.stringify({ by: 'team' }) });

    it('refuses a Host that is not a loopback name locally (DNS rebinding)', async () => {
      const server = buildConsoleServer({ console: stubConsole });
      const res = await server.inject({ method: 'GET', url: '/console/api/businesses', remoteAddress: '127.0.0.1', headers: { host: 'evil.example:4000' } });
      expect(res.statusCode).toBe(403);
      for (const host of ['localhost:4000', '127.0.0.1:4000', '[::1]:4000', 'localhost']) {
        const ok = await server.inject({ method: 'GET', url: '/console/api/businesses', remoteAddress: '127.0.0.1', headers: { host } });
        expect(ok.statusCode, host).toBe(200);
      }
      await server.close();
    });

    it('deployed, accepts only the configured hosts when they are set', async () => {
      const server = buildConsoleServer({ console: stubConsole, auth: { mode: 'iap', verifier }, allowedHosts: ['console.internal'] });
      const signedIn = { [IAP_HEADER]: iap.assertion() };
      expect((await server.inject({ method: 'GET', url: '/console/api/businesses', headers: { ...signedIn, host: 'console.internal' } })).statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: '/console/api/businesses', headers: { ...signedIn, host: 'other.example' } })).statusCode).toBe(403);
      await server.close();
    });

    it('refuses a POST without a JSON content type', async () => {
      const server = buildConsoleServer({ console: stubConsole });
      expect((await post(server, { host: 'localhost:4000', 'content-type': 'text/plain' })).statusCode).toBe(415);
      await server.close();
    });

    it('refuses a POST from another origin and accepts the same origin', async () => {
      const server = buildConsoleServer({ console: stubConsole });
      const json = { host: 'localhost:4000', 'content-type': 'application/json' };
      expect((await post(server, { ...json, origin: 'https://evil.example' })).statusCode).toBe(403);
      expect((await post(server, { ...json, origin: 'null' })).statusCode).toBe(403);
      expect((await post(server, { ...json, origin: 'http://localhost:4000' })).statusCode).toBe(200);
      expect((await post(server, json)).statusCode).toBe(200);
      await server.close();
    });
  });

  describe('IAP sign-in (D1, WP-82)', () => {
    const recording = () => {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const console = new Proxy({}, { get: (_t, method: string) => async (...args: unknown[]) => void calls.push({ method, args }) }) as unknown as ConsoleService;
      return { console, calls };
    };
    const json = { host: 'localhost', 'content-type': 'application/json' };

    it('refuses a request without the IAP header, or with a forged or expired one (401)', async () => {
      const server = buildConsoleServer({ console: stubConsole, auth: { mode: 'iap', verifier } });
      const get = (url: string, headers: Record<string, string>) => server.inject({ method: 'GET', url, remoteAddress: '10.0.0.5', headers });
      const forger = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
      // The page itself needs the sign-in too.
      expect((await get('/console', {})).statusCode).toBe(401);
      for (const url of ['/console/api/businesses', '/console/api/system']) {
        expect((await get(url, {})).statusCode, url).toBe(401);
        expect((await get(url, { [IAP_HEADER]: 'not-a-jwt' })).statusCode).toBe(401);
        expect((await get(url, { [IAP_HEADER]: iap.assertion(undefined, { key: forger }) })).statusCode).toBe(401);
        expect((await get(url, { [IAP_HEADER]: iap.assertion(undefined, { now: Math.floor(Date.now() / 1000) - 3600 }) })).statusCode).toBe(401);
        // The unsigned email header IAP also sends is never enough.
        expect((await get(url, { 'x-goog-authenticated-user-email': 'accounts.google.com:team@postly.test' })).statusCode).toBe(401);
        expect((await get(url, { [IAP_HEADER]: iap.assertion() })).statusCode).toBe(200);
      }
      await server.close();
    });

    it('refuses every console request when no audience is configured, but still answers /healthz', async () => {
      const server = buildConsoleServer({ console: stubConsole, auth: { mode: 'iap' } });
      expect((await server.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      const res = await server.inject({ method: 'GET', url: '/console/api/businesses', headers: { [IAP_HEADER]: iap.assertion() } });
      expect(res.statusCode).toBe(403);
      await server.close();
    });

    it("records the signed-in email as the actor, not the body's by (D4)", async () => {
      const { console, calls } = recording();
      const lines: object[] = [];
      const server = buildConsoleServer({ console, auth: { mode: 'iap', verifier }, log: (line) => void lines.push(line) });
      const post = (url: string, payload: object) =>
        server.inject({ method: 'POST', url, headers: { ...json, [IAP_HEADER]: iap.assertion('dana@postly.test') }, payload: JSON.stringify(payload) });

      expect((await post('/console/api/system/pause', { by: 'someone-else', reason: 'provider outage' })).statusCode).toBe(200);
      expect((await post('/console/api/system/resume', {})).statusCode).toBe(200);
      expect((await post('/console/api/price', { amountAgorot: 32000 })).statusCode).toBe(200);

      expect(calls).toEqual([
        { method: 'setGlobalPause', args: [true, 'dana@postly.test', 'provider outage (by: someone-else)'] },
        { method: 'setGlobalPause', args: [false, 'dana@postly.test'] },
        { method: 'setPrice', args: [{ amountAgorot: 32000, by: 'dana@postly.test' }] },
      ]);
      expect(lines).toEqual([
        expect.objectContaining({ msg: 'console action', actor: 'dana@postly.test', method: 'POST', path: '/console/api/system/pause', status: 200 }),
        expect.objectContaining({ msg: 'console action', actor: 'dana@postly.test', path: '/console/api/system/resume' }),
        expect.objectContaining({ msg: 'console action', actor: 'dana@postly.test', path: '/console/api/price' }),
      ]);
      await server.close();
    });

    it('passes the actor to the cancellation', async () => {
      const cancelled: unknown[][] = [];
      const id = '0b7c4a52-8d0e-4b8e-9d7a-1f2a3b4c5d6e';
      const named = new Proxy({}, { get: (_t, key) => async () => (key === 'businesses' ? [{ id, name: 'מאפיית רחל' }] : []) }) as unknown as ConsoleService;
      const server = buildConsoleServer({ console: named, auth: { mode: 'iap', verifier }, log: () => {}, cancelBusiness: async (...args) => void cancelled.push(args) });
      const payload = JSON.stringify({ confirmName: 'מאפיית רחל' });
      const res = await server.inject({ method: 'POST', url: `/console/api/businesses/${id}/cancel`, headers: { ...json, [IAP_HEADER]: iap.assertion('dana@postly.test') }, payload });
      expect(res.statusCode).toBe(200);
      expect(cancelled).toEqual([[id, 'dana@postly.test']]);
      await server.close();
    });

    it('keeps the CSRF checks for a signed-in request', async () => {
      const server = buildConsoleServer({ console: stubConsole, auth: { mode: 'iap', verifier } });
      const headers = { ...json, [IAP_HEADER]: iap.assertion(), origin: 'https://evil.example' };
      expect((await server.inject({ method: 'POST', url: '/console/api/system/resume', headers, payload: '{}' })).statusCode).toBe(403);
      await server.close();
    });

    it('with the dev bypass, uses the configured local actor', async () => {
      const { console, calls } = recording();
      const server = buildConsoleServer({ console, auth: { mode: 'dev-bypass', actor: 'me@local' }, log: () => {} });
      await server.inject({ method: 'POST', url: '/console/api/system/resume', remoteAddress: '127.0.0.1', headers: json, payload: '{}' });
      expect(calls).toEqual([{ method: 'setGlobalPause', args: [false, 'me@local'] }]);
      await server.close();
    });
  });
});
