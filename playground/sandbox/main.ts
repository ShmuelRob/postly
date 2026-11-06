import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { createPostgresSimulatorStore } from '../../src/db/index.js';
import { asError, log, setLogLabels } from '../../src/shared/logger.js';
import { createSandbox } from './sandbox.js';

// The dev sandbox service (WP-51, docs/deployment.md "The sandbox"), from its own image
// (Dockerfile.sandbox), never the product image. loadConfig refuses the simulators outside local,
// test and dev; the sandbox also refuses to start anywhere but dev or local, and only on the shared
// Postgres store, since an in-memory store would show nothing the web service did.

const STATIC_DIR = fileURLToPath(new URL('./web/', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function main() {
  setLogLabels({ process: 'sandbox' });
  const config = loadConfig(process.env);
  if (config.env !== 'dev' && config.env !== 'local') throw new Error(`the sandbox runs only in dev or local, not ${config.env}`);
  if (config.simulators.store !== 'postgres') throw new Error('the sandbox needs SIMULATOR_STORE=postgres, shared with web and worker');
  const ownerPhone = process.env.SANDBOX_OWNER_PHONE;
  if (!ownerPhone) throw new Error('SANDBOX_OWNER_PHONE is required: the number the human plays');
  const store = createPostgresSimulatorStore(config.simulators.storeUrl, { max: 2 });
  const sandbox = await createSandbox({
    databaseUrls: config.databaseUrls,
    store,
    webhookSecret: config.webhookSecret,
    publicBaseUrl: config.publicBaseUrl,
    businessNumber: config.businessNumber,
    ownerPhone,
  });

  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end('{"ok":true}');
    }
    sandbox.handle(req, res, () => {
      // The UI: a built file, or index.html for the app's own routes (/checkout/<id>).
      const path = normalize(join(STATIC_DIR, new URL(req.url ?? '/', 'http://x').pathname));
      const file = path.startsWith(STATIC_DIR) && existsSync(path) && statSync(path).isFile() ? path : join(STATIC_DIR, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
      createReadStream(file).pipe(res);
    });
  });
  server.listen(config.port, '0.0.0.0');
  log.info('sandbox started');
  process.once('SIGTERM', async () => {
    server.close();
    await sandbox.close();
    await store.close();
    process.exit(0);
  });
}

main().catch((error: unknown) => {
  log.error('sandbox startup failed', { error: asError(error) });
  process.exit(1);
});
