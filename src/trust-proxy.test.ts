import { describe, expect, it } from 'vitest';
import type { ConsoleService } from './modules/console/index.js';
import type { Messaging } from './modules/messaging/index.js';
import { buildConsoleServer } from './console-server.js';
import { buildServer } from './server.js';

// D8 (docs/security.md, WP-81): behind Cloud Run's single front-end hop, `request.ip` is the address
// that hop saw (the last X-Forwarded-For entry), never a caller-supplied leftmost entry.

const stubMessaging = new Proxy({}, { get: () => async () => {} }) as unknown as Messaging;
const stubConsole = new Proxy({}, { get: () => async () => [] }) as unknown as ConsoleService;

const ipOf = async (app: ReturnType<typeof buildServer>, xff?: string) => {
  app.get('/__ip', async (request) => ({ ip: request.ip }));
  const res = await app.inject({ method: 'GET', url: '/__ip', remoteAddress: '10.1.2.3', ...(xff ? { headers: { 'x-forwarded-for': xff } } : {}) });
  await app.close();
  return (res.json() as { ip: string }).ip;
};

describe('trustProxy (D8)', () => {
  it('web: trusts one hop, so a spoofed leftmost entry is ignored', async () => {
    const ip = await ipOf(buildServer({ messaging: stubMessaging, publicBaseUrl: 'http://x', trustProxyHops: 1 }), '6.6.6.6, 203.0.113.9');
    expect(ip).toBe('203.0.113.9');
  });

  it('web: off by default, the socket address is the client', async () => {
    expect(await ipOf(buildServer({ messaging: stubMessaging, publicBaseUrl: 'http://x' }), '203.0.113.9')).toBe('10.1.2.3');
  });

  // The loopback gate reads the socket's remote address, never X-Forwarded-For, whatever trustProxy is.
  for (const trustProxyHops of [undefined, 1]) {
    it(`console loopback gate: a spoofed X-Forwarded-For 127.0.0.1 from a non-loopback socket is refused (hops ${trustProxyHops ?? 'unset'})`, async () => {
      const app = buildConsoleServer({ console: stubConsole, access: 'loopback', ...(trustProxyHops ? { trustProxyHops } : {}) });
      const res = await app.inject({ method: 'GET', url: '/console/api/businesses', remoteAddress: '10.0.0.5', headers: { host: 'localhost', 'x-forwarded-for': '127.0.0.1' } });
      await app.close();
      expect(res.statusCode).toBe(403);
    });

    it(`console loopback gate: a loopback socket is served even with a foreign X-Forwarded-For (hops ${trustProxyHops ?? 'unset'})`, async () => {
      const app = buildConsoleServer({ console: stubConsole, access: 'loopback', ...(trustProxyHops ? { trustProxyHops } : {}) });
      const res = await app.inject({ method: 'GET', url: '/console/api/businesses', remoteAddress: '127.0.0.1', headers: { host: 'localhost', 'x-forwarded-for': '203.0.113.9' } });
      await app.close();
      expect(res.statusCode).toBe(200);
    });
  }

  it('console: trusts one hop when set', async () => {
    const app = buildConsoleServer({ console: stubConsole, access: 'private-ingress', trustProxyHops: 1 });
    expect(await ipOf(app, '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
  });
});
