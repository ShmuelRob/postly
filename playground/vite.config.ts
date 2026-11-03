import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type * as Start from './server/start.js';
import { playgroundApi } from './vite-plugin.js';

const start = fileURLToPath(new URL('./server/start.ts', import.meta.url));

// `npm run playground`: the UI with the real app in-process on the simulators. Local only.
export default defineConfig({
  root: fileURLToPath(new URL('./web/', import.meta.url)),
  plugins: [
    react(),
    playgroundApi(async (server) => ((await server.ssrLoadModule(start)) as typeof Start).startLocalPlayground()),
  ],
  server: { port: 5175, host: '127.0.0.1' },
});
