import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ConsoleActionError, type ConsoleService } from './console.js';
import { renderConsolePage } from './page.js';

export const CONSOLE_PATH = '/console';

export interface ConsoleRouteOptions {
  console: ConsoleService;
  /** The cancellation (WP-43); the route exists only when it is wired. */
  cancelBusiness?(businessId: string): Promise<unknown>;
}

// Team sign-in is not defined yet (technical-design.md, "Console (Phase 1)"): only loopback requests.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const Id = z.object({ id: z.uuid() });
const PauseBody = z.object({ by: z.string().min(1), reason: z.string().optional() });
const DraftsQuery = z.object({ businessId: z.uuid().optional() });
const PriceQuery = z.object({ plan: z.string().min(1).optional() });
const PriceBody = z.object({
  plan: z.string().min(1).optional(),
  amountAgorot: z.number().int().positive(),
  by: z.string().min(1),
  reason: z.string().optional(),
});

/** GET /console (React page) and the JSON API under /console/api. */
export function registerConsoleRoutes(app: FastifyInstance, options: ConsoleRouteOptions): void {
  const c = options.console;
  app.register(
    async (scope) => {
      scope.addHook('onRequest', async (request, reply) => {
        if (!LOOPBACK.has(request.ip)) return reply.code(403).send({ error: 'console is local only' });
      });

      const run = async (reply: FastifyReply, action: () => Promise<unknown>) => {
        try {
          const result = await action();
          return reply.code(200).send(result ?? { ok: true });
        } catch (error) {
          if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid request', issues: error.issues });
          if (error instanceof ConsoleActionError) return reply.code(error.status).send({ reason: error.reason, detail: error.detail });
          throw error;
        }
      };
      const id = (params: unknown) => Id.parse(params).id;

      scope.get('/', async (_request, reply) => {
        const [businesses, drafts, items, system, price] = await Promise.all([c.businesses(), c.drafts(), c.openItems(), c.system(), c.price()]);
        const conversations = await Promise.all(businesses.slice(0, 20).map(async (b) => [b.id, await c.messages(b.id)] as const));
        const html = renderConsolePage({ businesses, drafts, items, system, price, conversations: Object.fromEntries(conversations) });
        return reply.type('text/html; charset=utf-8').send(html);
      });

      scope.get('/api/businesses', (_q, reply) => run(reply, () => c.businesses()));
      scope.get('/api/businesses/:id/messages', (q, reply) => run(reply, () => c.messages(id(q.params))));
      scope.get('/api/drafts', (q, reply) => run(reply, () => c.drafts(DraftsQuery.parse(q.query).businessId)));
      scope.get('/api/items', (_q, reply) => run(reply, () => c.openItems()));
      scope.get('/api/system', (_q, reply) => run(reply, () => c.system()));

      scope.post('/api/items/:id/resolve', (q, reply) => run(reply, () => c.resolveItem(id(q.params))));
      scope.post('/api/items/:id/route', (q, reply) => run(reply, () => c.routeItem(id(q.params))));
      scope.post('/api/businesses/:id/handoff', (q, reply) => run(reply, () => c.startHandoff(id(q.params))));
      scope.post('/api/businesses/:id/handoff/clear', (q, reply) => run(reply, () => c.clearHandoff(id(q.params))));
      if (options.cancelBusiness) {
        const cancelBusiness = options.cancelBusiness;
        scope.post('/api/businesses/:id/cancel', (q, reply) => run(reply, () => cancelBusiness(id(q.params))));
      }
      scope.post('/api/businesses/:id/pause', (q, reply) => run(reply, () => c.pauseBusiness(id(q.params))));
      scope.post('/api/businesses/:id/resume', (q, reply) => run(reply, () => c.resumeBusiness(id(q.params))));
      scope.post('/api/publications/:id/retry', (q, reply) => run(reply, () => c.retryPublication(id(q.params))));
      scope.post('/api/system/pause', (q, reply) =>
        run(reply, () => {
          const body = PauseBody.parse(q.body ?? {});
          return c.setGlobalPause(true, body.by, body.reason);
        }),
      );
      scope.get('/api/price', (q, reply) => run(reply, () => c.price(PriceQuery.parse(q.query).plan)));
      scope.post('/api/price', (q, reply) =>
        run(reply, () => {
          const { plan, amountAgorot, by, reason } = PriceBody.parse(q.body ?? {});
          return c.setPrice({ amountAgorot, by, ...(plan ? { plan } : {}), ...(reason ? { reason } : {}) });
        }),
      );
      scope.post('/api/system/resume', (q, reply) => run(reply, () => c.setGlobalPause(false, PauseBody.parse(q.body ?? {}).by)));
    },
    { prefix: CONSOLE_PATH },
  );
}
