import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer, type Plugin } from 'vite';
import type { Sandbox } from './sandbox.js';

export interface SandboxUi {
  url: string;
  close(): Promise<void>;
}

/** Serves the playground UI (`playground/web`) with the sandbox API, through Vite (tests and local runs). */
export async function startSandboxUi(sandbox: Sandbox, options: { port?: number } = {}): Promise<SandboxUi> {
  const api: Plugin = {
    name: 'postly-sandbox-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => sandbox.handle(req, res, next));
    },
  };
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../web/', import.meta.url)),
    plugins: [react(), api],
    server: { port: options.port ?? 0, strictPort: false, host: '127.0.0.1' },
    logLevel: 'warn',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('sandbox UI did not start');
  return { url: `http://127.0.0.1:${address.port}/`, close: () => server.close() };
}
