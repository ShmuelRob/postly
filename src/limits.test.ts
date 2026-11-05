import { describe, expect, it } from 'vitest';
import type { Billing } from './modules/billing/index.js';
import type { ConsoleService } from './modules/console/index.js';
import { PAYMENT_WEBHOOK_PATH } from './modules/billing/index.js';
import { WEBHOOK_PATH, type Messaging } from './modules/messaging/index.js';
import { buildConsoleServer } from './console-server.js';
import { buildServer } from './server.js';

// D12 (docs/security.md, WP-85): body-size limits and a per-process rate limit on the public webhooks
// and the console, both enforced before the HMAC check runs.

let verified = 0;
const messaging = new Proxy({}, { get: (_t, k) => (k === 'handleWebhook' ? async () => { verified++; return []; } : async () => {}) }) as unknown as Messaging;
const billing = new Proxy({}, { get: (_t, k) => (k === 'handleWebhook' ? async () => { verified++; return { kind: 'ignored' }; } : async () => {}) }) as unknown as Billing;
const stubConsole = new Proxy({}, { get: () => async () => [] }) as unknown as ConsoleService;

describe('request limits (D12)', { timeout: 30_000 }, () => {
  it('refuses an oversized webhook body with 413 before verifying it', async () => {
    verified = 0;
    const app = buildServer({ messaging, billing, publicBaseUrl: 'http://x' });
    for (const url of [WEBHOOK_PATH, PAYMENT_WEBHOOK_PATH]) {
      const res = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'a'.repeat(300 * 1024) });
      expect(res.statusCode, url).toBe(413);
    }
    expect(verified).toBe(0);
    await app.close();
  });

  it('answers 429 with Retry-After once the webhook limit is spent, without verifying', async () => {
    verified = 0;
    const app = buildServer({ messaging, publicBaseUrl: 'http://x', limits: { messagingPerMinute: 2 } });
    const hit = () => app.inject({ method: 'POST', url: WEBHOOK_PATH, payload: 'x' });
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(200);
    const limited = await hit();
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(verified).toBe(2);
    await app.close();
  });

  it('limits the console API body size and rate', async () => {
    const server = buildConsoleServer({ console: stubConsole, access: 'loopback', limits: { consolePerMinute: 1 } });
    const big = await server.inject({ method: 'POST', url: '/console/api/system/pause', remoteAddress: '127.0.0.1', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ by: 'a'.repeat(100 * 1024) }) });
    expect(big.statusCode).toBe(413);
    const second = await server.inject({ method: 'GET', url: '/console/api/businesses', remoteAddress: '127.0.0.1' });
    expect(second.statusCode).toBe(429);
    await server.close();
  });
});
