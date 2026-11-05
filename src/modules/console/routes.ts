import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ConsoleActionError, type ConsoleService } from './console.js';
import { renderConsolePage } from './page.js';

export const CONSOLE_PATH = '/console';

export interface ConsoleRouteOptions {
  console: ConsoleService;
  /** The cancellation (WP-43); the route exists only when it is wired. */
  cancelBusiness?(businessId: string): Promise<unknown>;
  /**
   * How requests are gated until team sign-in exists (docs/security.md, "Console exposure").
   * `loopback` (default, local runs): only loopback addresses. `private-ingress` (deployed): the
   * console runs as its own Cloud Run service with internal-only ingress and no public invoker, so the
   * gate is the network and IAM, not the request's address. Neither is a sign-in.
   */
  access?: 'loopback' | 'private-ingress';
  /**
   * Host names (no port) the console answers, against DNS rebinding (D3). Locally the default is the
   * loopback names; deployed, unset leaves the Host check to the internal-only ingress.
   */
  allowedHosts?: readonly string[];
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** The host name of a Host header or Origin, without the port; undefined when it does not parse. */
function hostName(value: string): string | undefined {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return undefined;
  }
}

const Id = z.object({ id: z.uuid() });
const PauseBody = z.object({ by: z.string().min(1), reason: z.string().optional() });
/** D2 (docs/security.md): the business name, typed by the team member, confirms a cancellation. */
const CancelBody = z.object({ confirmName: z.string().trim().min(1) });
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
      const loopbackOnly = (options.access ?? 'loopback') === 'loopback';
      scope.addHook('onRequest', async (request, reply) => {
        if (loopbackOnly && !LOOPBACK.has(request.ip)) return reply.code(403).send({ error: 'console is local only' });
        // CSRF and DNS rebinding (docs/security.md, D3): a known Host, and for any POST a JSON body
        // (which a cross-origin page cannot send without a CORS preflight) and no foreign Origin.
        const host = request.headers.host ?? '';
        const allowed = options.allowedHosts ?? (loopbackOnly ? LOOPBACK_HOSTS : undefined);
        if (allowed && !allowed.includes(hostName(host) ?? '')) return reply.code(403).send({ error: 'unknown host' });
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          const origin = request.headers.origin;
          if (origin !== undefined && (origin === 'null' || new URL(origin, 'http://x').host !== host)) {
            return reply.code(403).send({ error: 'cross-origin request' });
          }
          if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
            return reply.code(415).send({ error: 'JSON body required' });
          }
        }
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
        scope.post('/api/businesses/:id/cancel', (q, reply) =>
          run(reply, async () => {
            const businessId = id(q.params);
            const { confirmName } = CancelBody.parse(q.body ?? {});
            const target = (await c.businesses()).find((b) => b.id === businessId);
            if (!target) throw new ConsoleActionError(404, 'not_found');
            if (target.name.trim() !== confirmName) throw new ConsoleActionError(400, 'confirmation_mismatch', 'type the business name to confirm');
            return cancelBusiness(businessId);
          }),
        );
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
