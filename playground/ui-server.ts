import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import type { Playground } from './server/playground.js';
import { playgroundApi } from './vite-plugin.js';

export interface PlaygroundUi {
  url: string;
  close(): Promise<void>;
}

/** Serves the playground UI for an already-built playground (the e2e test uses this). */
export async function startPlaygroundUi(playground: Playground, options: { port?: number } = {}): Promise<PlaygroundUi> {
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('./web/', import.meta.url)),
    plugins: [react(), playgroundApi(async () => playground)],
    server: { port: options.port ?? 0, strictPort: false, host: '127.0.0.1' },
    logLevel: 'warn',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('playground UI did not start');
  return { url: `http://127.0.0.1:${address.port}/`, close: () => server.close() };
}
