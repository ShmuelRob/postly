import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FixedWindowLimiter, rateLimitHook } from '../../shared/rate-limit.js';
import { ConsoleActionError, type ConsoleService } from './console.js';
import { IAP_HEADER, IapAssertionError, type IapVerifier } from './iap.js';
import { log } from '../../shared/logger.js';
import { renderConsolePage } from './page.js';
import { loadPageData } from './page-data.js';

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
  /**
   * The bytes of a stored file by its storage path, for GET /console/media/:assetId (security.md,
   * "Media in the console"); without it that route answers 404. A missing file throws.
   */
  readMedia?(storagePath: string): Promise<Uint8Array>;
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

// The redesigned console's API (technical-design.md, "Console (Phase 1)"). Unknown keys are refused;
// the actor comes from the sign-in, never from a body.
const Reason = z.string().max(500).optional();
const AssetId = z.object({ assetId: z.uuid() });
const Name = (key: 'agent' | 'task') => z.object({ [key]: z.string().min(1).max(100) });
const ModelRunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() });
const ActionsQuery = z.object({ businessId: z.uuid().optional() });
const ProfileBody = z.object({ profile: z.record(z.string(), z.unknown()), reason: Reason }).strict();
const CostCapBody = z.object({ usd: z.number().positive(), reason: Reason }).strict();
const positiveInt = z.number().int().positive().optional();
const positiveUsd = z.number().positive().optional();
const AgentConfigBody = z
  .object({
    maxSteps: positiveInt,
    maxToolCalls: positiveInt,
    maxTurnCostUsd: positiveUsd,
    maxBusinessDailyCostUsd: positiveUsd,
    timeoutMs: positiveInt,
    minConfidence: z.number().min(0).max(1).optional(),
    maxRefusals: positiveInt,
    maxRepeatedQuestions: positiveInt,
    reason: Reason,
  })
  .strict();
const ModelTaskBody = z
  .object({
    model: z.string().trim().min(1).optional(),
    fallbackModel: z.string().trim().min(1).nullable().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxCostUsd: z.number().positive().optional(),
    maxRetries: z.number().int().min(0).max(5).optional(),
    activePromptVersion: z.number().int().optional(),
    reason: Reason,
  })
  .strict();

/** WriteMeta of a write: the signed-in actor, and the reason when one was typed. */
const meta = (actor: string, reason: string | undefined) => (reason === undefined ? { actor } : { actor, reason });
/** The body's fields without `reason` and without the keys left out (exactOptionalPropertyTypes). */
const patchOf = <T extends Record<string, unknown>>({ reason: _, ...rest }: T & { reason?: string | undefined }) =>
  Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as { [K in keyof Omit<T, 'reason'>]-?: Exclude<T[K], undefined> };

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
        const html = renderConsolePage(await loadPageData(c, request.query, consoleActor(request)));
        return reply.type('text/html; charset=utf-8').header('cache-control', 'private, no-store').send(html);
      });

      scope.get('/api/businesses', (_q, reply) => run(reply, () => c.businesses()));
      scope.get('/api/overview', (_q, reply) => run(reply, () => c.overview()));
      scope.get('/api/business-rows', (_q, reply) => run(reply, () => c.businessRows()));
      scope.get('/api/businesses/:id', (q, reply) => run(reply, () => c.business(id(q.params))));
      scope.get('/api/businesses/:id/posts', (q, reply) => run(reply, () => c.posts(id(q.params))));
      scope.get('/api/businesses/:id/model-runs', (q, reply) => run(reply, () => c.modelRuns(id(q.params))));
      scope.get('/api/model-runs', (q, reply) => run(reply, () => c.modelRuns(undefined, ModelRunsQuery.parse(q.query).limit)));
      scope.get('/api/model-runs/:id', (q, reply) => run(reply, () => c.modelRun(id(q.params))));
      scope.get('/api/settings', (_q, reply) => run(reply, () => c.settings()));
      scope.get('/api/model-tasks', (_q, reply) => run(reply, () => c.modelTasks()));
      scope.get('/api/agent-config', (_q, reply) => run(reply, () => c.agentConfigs()));
      scope.get('/api/actions', (q, reply) => run(reply, () => c.actions(ActionsQuery.parse(q.query).businessId)));
      // security.md, "Media in the console": the bytes behind the same sign-in, never a public URL.
      scope.get('/media/:assetId', async (q, reply) => {
        const parsed = AssetId.safeParse(q.params);
        if (!options.readMedia || !parsed.success) return reply.code(404).send({ reason: 'not_found' });
        try {
          const asset = await c.mediaAsset(parsed.data.assetId);
          const bytes = await options.readMedia(asset.storagePath);
          return reply
            .code(200)
            .header('cache-control', 'private, no-store')
            .header('x-content-type-options', 'nosniff')
            .type(asset.mimeType)
            .send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        } catch (error) {
          if (error instanceof ConsoleActionError) return reply.code(error.status).send({ reason: error.reason });
          throw error;
        }
      });
      scope.get('/api/businesses/:id/messages', (q, reply) => run(reply, () => c.messages(id(q.params))));
      scope.get('/api/businesses/:id/agent-turns', (q, reply) => run(reply, () => c.agentTurns(id(q.params))));
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
      scope.post('/api/businesses/:id/profile', (q, reply) =>
        run(reply, () => {
          const { profile, reason } = ProfileBody.parse(q.body ?? {});
          return c.setProfile(id(q.params), profile, meta(consoleActor(q), reason));
        }),
      );
      scope.post('/api/system/agent-cost-cap', (q, reply) =>
        run(reply, () => {
          const { usd, reason } = CostCapBody.parse(q.body ?? {});
          return c.setAgentCostCap(usd, meta(consoleActor(q), reason));
        }),
      );
      scope.post('/api/agent-config/:agent', (q, reply) =>
        run(reply, () => {
          const { agent } = Name('agent').parse(q.params) as { agent: string };
          const body = AgentConfigBody.parse(q.body ?? {});
          return c.setAgentConfig(agent, patchOf(body), meta(consoleActor(q), body.reason));
        }),
      );
      scope.post('/api/model-tasks/:task', (q, reply) =>
        run(reply, () => {
          const { task } = Name('task').parse(q.params) as { task: string };
          const body = ModelTaskBody.parse(q.body ?? {});
          return c.setModelTask(task, patchOf(body), meta(consoleActor(q), body.reason));
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
