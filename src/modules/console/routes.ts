import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FixedWindowLimiter, rateLimitHook } from '../../shared/rate-limit.js';
import { ConsoleActionError, type ConsoleService } from './console.js';
import { IAP_HEADER, IapAssertionError, type IapVerifier } from './iap.js';
import { log } from '../../shared/logger.js';
import { renderConsolePage } from './page.js';

export const CONSOLE_PATH = '/console';

/**
 * How the console knows who is acting (docs/security.md, "Console exposure"; D1, D4).
 * `iap` (deployed): every request needs a valid IAP assertion, and its email is the actor; without
 * a verifier (no audience configured) every console request is refused. `dev-bypass` (local runs
 * and tests only; `src/config.ts` refuses it in stage and prod): loopback addresses only, with a
 * fixed actor.
 */
export type ConsoleAuth = { mode: 'iap'; verifier?: IapVerifier } | { mode: 'dev-bypass'; actor?: string };

export const DEV_ACTOR = 'local-dev';

export interface ConsoleRouteOptions {
  console: ConsoleService;
  /** The cancellation (WP-43); the route exists only when it is wired. */
  cancelBusiness?(businessId: string, actor: string): Promise<unknown>;
  /** Defaults to the dev bypass. */
  auth?: ConsoleAuth;
  /**
   * Host names (no port) the console answers, against DNS rebinding (D3). With the dev bypass the
   * default is the loopback names; deployed, it is the console's domain (`CONSOLE_HOST`).
   */
  allowedHosts?: readonly string[];
  /** Console requests admitted per minute in this process before 429 (docs/security.md, D12). */
  perMinute?: number;
  /** One line per console action (actor, method, path, status); defaults to the shared logger. */
  log?(line: Record<string, unknown>): void;
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

/** A `by` typed in the body is only a note now (D4): kept in the reason when it names someone else. */
function withNote(reason: string | undefined, by: string | undefined, actor: string): string | undefined {
  if (!by || by === actor) return reason;
  return reason ? `${reason} (by: ${by})` : `(by: ${by})`;
}

const Id = z.object({ id: z.uuid() });
const PauseBody = z.object({ by: z.string().min(1).optional(), reason: z.string().optional() });
/** D2 (docs/security.md): the business name, typed by the team member, confirms a cancellation. */
const CancelBody = z.object({ confirmName: z.string().trim().min(1) });
const DraftsQuery = z.object({ businessId: z.uuid().optional() });
const PriceQuery = z.object({ plan: z.string().min(1).optional() });
const PriceBody = z.object({
  plan: z.string().min(1).optional(),
  amountAgorot: z.number().int().positive(),
  by: z.string().min(1).optional(),
  reason: z.string().optional(),
});

const actors = new WeakMap<FastifyRequest, string>();

/** The signed-in team member of a console request (set by the sign-in hook before any handler). */
export function consoleActor(request: FastifyRequest): string {
  const actor = actors.get(request);
  if (!actor) throw new Error('console request without an actor');
  return actor;
}

/** GET /console (React page) and the JSON API under /console/api. */
export function registerConsoleRoutes(app: FastifyInstance, options: ConsoleRouteOptions): void {
  const c = options.console;
  const limiter = new FixedWindowLimiter({ limit: options.perMinute ?? 300 });
  const auth = options.auth ?? { mode: 'dev-bypass' };
  const logAction =
    options.log ??
    (({ msg, ...fields }) => log.info(String(msg), Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'number' ? v : String(v)]))));
  app.register(
    async (scope) => {
      scope.addHook('onRequest', rateLimitHook(limiter));
      scope.addHook('onRequest', async (request, reply) => {
        // The socket peer, never `request.ip`: with trustProxy set, `request.ip` comes from X-Forwarded-For,
        // which a caller can spoof (docs/security.md, D8).
        if (auth.mode === 'dev-bypass' && !LOOPBACK.has(request.raw.socket.remoteAddress ?? '')) return reply.code(403).send({ error: 'console is local only' });
        // CSRF and DNS rebinding (docs/security.md, D3): a known Host, and for any POST a JSON body
        // (which a cross-origin page cannot send without a CORS preflight) and no foreign Origin.
        const host = request.headers.host ?? '';
        const allowed = options.allowedHosts ?? (auth.mode === 'dev-bypass' ? LOOPBACK_HOSTS : undefined);
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
        // Sign-in (D1): the actor comes only from a verified IAP assertion, or the local bypass.
        if (auth.mode === 'dev-bypass') {
          actors.set(request, auth.actor ?? DEV_ACTOR);
          return;
        }
        if (!auth.verifier) return reply.code(403).send({ error: 'console sign-in is not configured' });
        const assertion = request.headers[IAP_HEADER];
        if (typeof assertion !== 'string') return reply.code(401).send({ error: 'sign-in required' });
        try {
          actors.set(request, (await auth.verifier.verify(assertion)).email);
        } catch (error) {
          if (error instanceof IapAssertionError) return reply.code(401).send({ error: 'sign-in required', reason: error.reason });
          throw error;
        }
      });
      scope.addHook('onResponse', async (request, reply) => {
        const actor = actors.get(request);
        if (actor && request.method === 'POST') {
          logAction({ msg: 'console action', actor, method: request.method, path: request.url.split('?')[0], status: reply.statusCode });
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

      scope.get('/', async (request, reply) => {
        const [businesses, drafts, items, system, price] = await Promise.all([c.businesses(), c.drafts(), c.openItems(), c.system(), c.price()]);
        const conversations = await Promise.all(businesses.slice(0, 20).map(async (b) => [b.id, await c.messages(b.id)] as const));
        const html = renderConsolePage({ businesses, drafts, items, system, price, conversations: Object.fromEntries(conversations), actor: consoleActor(request) });
        return reply.type('text/html; charset=utf-8').send(html);
      });

      scope.get('/api/businesses', (_q, reply) => run(reply, () => c.businesses()));
      scope.get('/api/businesses/:id/messages', (q, reply) => run(reply, () => c.messages(id(q.params))));
      scope.get('/api/drafts', (q, reply) => run(reply, () => c.drafts(DraftsQuery.parse(q.query).businessId)));
      scope.get('/api/items', (_q, reply) => run(reply, () => c.openItems()));
      scope.get('/api/system', (_q, reply) => run(reply, () => c.system()));

      scope.post('/api/items/:id/resolve', (q, reply) => run(reply, () => c.resolveItem(id(q.params))));
      scope.post('/api/items/:id/route', (q, reply) => run(reply, () => c.routeItem(id(q.params), consoleActor(q))));
      scope.post('/api/businesses/:id/handoff', (q, reply) => run(reply, () => c.startHandoff(id(q.params), consoleActor(q))));
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
            return cancelBusiness(businessId, consoleActor(q));
          }),
        );
      }
      scope.post('/api/businesses/:id/pause', (q, reply) => run(reply, () => c.pauseBusiness(id(q.params), consoleActor(q))));
      scope.post('/api/businesses/:id/resume', (q, reply) => run(reply, () => c.resumeBusiness(id(q.params), consoleActor(q))));
      scope.post('/api/publications/:id/retry', (q, reply) => run(reply, () => c.retryPublication(id(q.params), consoleActor(q))));
      scope.post('/api/system/pause', (q, reply) =>
        run(reply, () => {
          const actor = consoleActor(q);
          const body = PauseBody.parse(q.body ?? {});
          const reason = withNote(body.reason, body.by, actor);
          return reason === undefined ? c.setGlobalPause(true, actor) : c.setGlobalPause(true, actor, reason);
        }),
      );
      scope.get('/api/price', (q, reply) => run(reply, () => c.price(PriceQuery.parse(q.query).plan)));
      scope.post('/api/price', (q, reply) =>
        run(reply, () => {
          const actor = consoleActor(q);
          const { plan, amountAgorot, by, reason } = PriceBody.parse(q.body ?? {});
          const note = withNote(reason, by, actor);
          return c.setPrice({ amountAgorot, by: actor, ...(plan ? { plan } : {}), ...(note ? { reason: note } : {}) });
        }),
      );
      scope.post('/api/system/resume', (q, reply) =>
        run(reply, () => {
          PauseBody.parse(q.body ?? {});
          return c.setGlobalPause(false, consoleActor(q));
        }),
      );
    },
    { prefix: CONSOLE_PATH },
  );
}
