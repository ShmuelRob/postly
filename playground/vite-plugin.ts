import type { Plugin, ViteDevServer } from 'vite';
import type { Playground } from './server/playground.js';

/**
 * Mounts the playground API (`/api/*`) on the Vite dev server. `load` builds the playground once,
 * on the first request, so the page loads while the database starts.
 */
export function playgroundApi(load: (server: ViteDevServer) => Promise<Playground>): Plugin {
  return {
    name: 'postly-playground-api',
    configureServer(server) {
      let ready: Promise<Playground> | undefined;
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        ready ??= load(server);
        ready.then(
          (playground) => playground.handle(req, res, next),
          (error: unknown) => {
            // Try again on the next request, for example once Docker is running.
            ready = undefined;
            next(error);
          },
        );
      });
      server.httpServer?.once('close', () => void ready?.then((p) => p.close()));
    },
  };
}
