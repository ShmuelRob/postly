import { describe, expect, it } from 'vitest';
import { crossSiteWrite } from './origin.js';

// docs/security.md, "Sandbox exposure": with IAP the sandbox's session is a browser cookie, so a POST
// from another site must not reach /api/.

const req = (method: string, headers: Record<string, string>) => ({ method, headers });

describe('sandbox cross-site check', () => {
  it('lets the UI post from its own host, on the run.app URL or through the proxy', () => {
    expect(crossSiteWrite(req('POST', { host: 'postly-dev-sandbox-123.me-west1.run.app', origin: 'https://postly-dev-sandbox-123.me-west1.run.app' }))).toBe(false);
    expect(crossSiteWrite(req('POST', { host: 'localhost:8081', origin: 'http://localhost:8081' }))).toBe(false);
  });

  it('lets the UI post through gcloud run services proxy, which forwards with the run.app Host', () => {
    expect(crossSiteWrite(req('POST', { host: 'postly-dev-sandbox-123.me-west1.run.app', origin: 'http://localhost:8081' }))).toBe(false);
    expect(crossSiteWrite(req('POST', { host: 'postly-dev-sandbox-123.me-west1.run.app', origin: 'http://127.0.0.1:8081' }))).toBe(false);
  });

  it('refuses a POST from another site, or with a null or malformed Origin', () => {
    expect(crossSiteWrite(req('POST', { host: 'postly-dev-sandbox-123.me-west1.run.app', origin: 'https://evil.example' }))).toBe(true);
    expect(crossSiteWrite(req('POST', { host: 'localhost:8081', origin: 'null' }))).toBe(true);
    expect(crossSiteWrite(req('POST', { host: 'localhost:8081', origin: 'not a url' }))).toBe(true);
  });

  it('allows a POST with no Origin (curl, the tests) and every GET', () => {
    expect(crossSiteWrite(req('POST', { host: 'localhost:8081' }))).toBe(false);
    expect(crossSiteWrite(req('GET', { host: 'localhost:8081', origin: 'https://evil.example' }))).toBe(false);
  });
});
