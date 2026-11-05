import type { IncomingHttpHeaders } from 'node:http';

// docs/security.md, "Sandbox exposure": behind Cloud Run's IAP the sandbox's session is a browser
// cookie, so a page on another site could make the signed-in browser post to it (sign up a business,
// send messages as the owner). Browsers send Origin on every cross-origin POST, so a POST whose Origin
// is neither the sandbox's own host nor a loopback address is refused. Loopback is the
// `gcloud run services proxy` page (http://localhost:8081), which the proxy forwards with the run.app
// Host. A POST without Origin (curl, the tests) is not a browser's cross-site request.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function crossSiteWrite(req: { method?: string | undefined; headers: IncomingHttpHeaders }): boolean {
  if (req.method !== 'POST') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    const url = new URL(origin);
    return url.host !== req.headers.host && !LOOPBACK.has(url.hostname);
  } catch {
    return true;
  }
}
