import { z } from 'zod';
import { Phone } from './contracts/common.js';
import { type DatabaseUrls, databaseUrls, JOBS_LOGIN, poolConnections, PROCESS_LOGINS, SIMULATOR_LOGIN } from './db/index.js';
import { type AgentFlows, parseAgentFlows } from './agent-flows.js';
import { IAP_AUDIENCE_FORMS, IAP_AUDIENCE_PATTERN } from './modules/console/index.js';
import { DEFAULT_BURST_QUIET_MS } from './modules/messaging/index.js';
import { realModelsRefused } from './modules/model-layer/index.js';

export { PROCESS_LOGINS };
import { SIMULATOR_WEBHOOK_SECRET } from './simulators/index.js';

// Process configuration from the environment (docs/deployment.md). On Cloud Run each password is a
// Secret Manager secret mounted as an environment variable; locally docker-compose sets them.

const Env = z.object({
  /**
   * Required, with no default: a deployed service missing it must not fall back to the public
   * simulator webhook secret. `local` and `test` may use that secret; the deployed `dev`, `stage` and `prod` may not.
   */
  POSTLY_ENV: z.enum(['local', 'test', 'dev', 'stage', 'prod'], { error: 'POSTLY_ENV must be local, test, dev, stage or prod' }),
  /** Verifies inbound messaging webhooks; from Secret Manager on Cloud Run. */
  MESSAGING_WEBHOOK_SECRET: z.string().optional(),
  /**
   * `simulators` (local, test and dev only: simulated mode, WP-51) or `vendors` (refused until the
   * vendor adapters land, WP-41). Stage and prod therefore refuse to start until WP-41.
   */
  POSTLY_PROVIDERS: z.enum(['simulators', 'vendors'], { error: 'POSTLY_PROVIDERS must be "simulators" or "vendors"' }),
  /** Where the simulators keep their state: `memory` (local and test) or `postgres` (required in dev). */
  SIMULATOR_STORE: z.enum(['memory', 'postgres'], { error: 'SIMULATOR_STORE must be "memory" or "postgres"' }).optional(),
  /** The model provider: the model simulator, or Gemini through Vertex AI (T5; agent.md, Running on dev). */
  POSTLY_MODELS: z.enum(['simulator', 'vertex'], { error: 'POSTLY_MODELS must be "simulator" or "vertex"' }).default('simulator'),
  /** With POSTLY_MODELS=vertex: the project Vertex AI bills. */
  VERTEX_PROJECT: z.string().min(1).optional(),
  /**
   * With POSTLY_MODELS=vertex: the endpoint's location. `eu` (the EU multi-region) by default: Vertex serves
   * no Gemini from me-west1, and Gemini 3.5 Flash-Lite only on `global` and the `eu`/`us` multi-regions.
   */
  VERTEX_LOCATION: z
    .string()
    .regex(/^(global|eu|us|[a-z]+-[a-z]+\d+)$/, 'VERTEX_LOCATION must be global, eu, us or a region such as europe-west4')
    .default('eu'),
  /** Which flows run on the agent for every business; written into system_control at web startup. Unset: left alone. */
  POSTLY_AGENT_FLOWS: z.string().optional(),
  /**
   * The burst quiet window in milliseconds (technical-design.md, Operational defaults): inbound messages
   * from one number merge until this long passes without a new one. 20 s by default; dev sets 2 s.
   */
  BURST_QUIET_MS: z
    .string()
    .regex(/^\d+$/, 'BURST_QUIET_MS must be a whole number of milliseconds')
    .transform(Number)
    .refine((ms) => ms >= 500 && ms <= 60_000, 'BURST_QUIET_MS must be from 500 to 60000')
    .optional(),
  /** The server and database, with no user or password: each login gets its own. */
  DATABASE_URL: z.url().refine((u) => new URL(u).username === '', 'DATABASE_URL must have no user; each role login is built from it'),
  PUBLIC_BASE_URL: z.url(),
  /** Postly's WhatsApp number, E.164 like every phone in the contracts (a made-up one such as +15550000001 on the simulators). */
  BUSINESS_NUMBER: Phone,
  PORT: z.coerce.number().int().positive().default(8080),
  /** Connections per database login in this process (docs/security.md, D7); Terraform sets it from its budget. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(10).default(3),
  /** Console sign-in (docs/security.md, "Console exposure"): IAP when deployed, the dev bypass locally. */
  CONSOLE_AUTH: z.enum(['iap', 'dev-bypass'], { error: 'CONSOLE_AUTH must be iap or dev-bypass' }).optional(),
  /** From Terraform: the console backend service (load balancer) or Cloud Run service (built-in IAP) the IAP assertion must name. */
  CONSOLE_IAP_AUDIENCE: z.string().regex(IAP_AUDIENCE_PATTERN, `CONSOLE_IAP_AUDIENCE must be ${IAP_AUDIENCE_FORMS}`).optional(),
  /** From Terraform: the console's domain, or its run.app host with built-in IAP; any other Host is refused. */
  CONSOLE_HOST: z.string().min(1).optional(),
  CONSOLE_DEV_ACTOR: z.string().min(1).default('local-dev'),
});

export type ConsoleConfig = { auth: 'iap'; iapAudience?: string; host?: string } | { auth: 'dev-bypass'; devActor: string };

export interface Config {
  env: 'local' | 'test' | 'dev' | 'stage' | 'prod';
  webhookSecret: string;
  databaseUrls: DatabaseUrls;
  jobsUrl: string;
  publicBaseUrl: string;
  businessNumber: string;
  port: number;
  dbPoolMax: number;
  /** The most connections this process opens (poolConnections), logged at startup. */
  maxConnections: number;
  console: ConsoleConfig;
  /** Simulated mode (WP-51): where the simulators keep their state. */
  simulators: { store: 'memory' } | { store: 'postgres'; storeUrl: string };
  models: 'simulator' | 'vertex';
  /** With models `vertex`: where Gemini is called. */
  vertex?: { project: string; location: string };
  /** The global agent flow switch to apply at startup (POSTLY_AGENT_FLOWS); undefined leaves it as it is. */
  agentFlows?: AgentFlows;
  /** The burst quiet window (BURST_QUIET_MS). */
  burstQuietMs: number;
}

/** The environments where the simulators may answer (docs/deployment.md, "Simulated mode"). */
export const SIMULATED_ENVS: readonly string[] = ['local', 'test', 'dev'];

export const passwordVar = (login: string) => `DB_PASSWORD_${login.toUpperCase()}`;

function loginUrl(serverUrl: string, login: string, password: string): string {
  const url = new URL(serverUrl);
  url.username = login;
  url.password = password;
  return url.toString();
}

/** `process` limits the passwords read to that process's logins (docs/security.md, D9); web by default. */
export function loadConfig(env: Record<string, string | undefined>, process: keyof typeof PROCESS_LOGINS = 'web'): Config {
  const logins = PROCESS_LOGINS[process];
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration: ${z.prettifyError(parsed.error)}`);
  const { POSTLY_ENV: envName, POSTLY_PROVIDERS: providers, POSTLY_MODELS: models } = parsed.data;
  // First of all: the console's dev bypass never runs in stage or prod (docs/security.md, "Console exposure").
  if (parsed.data.CONSOLE_AUTH === 'dev-bypass' && (envName === 'stage' || envName === 'prod')) {
    throw new Error(`CONSOLE_AUTH=dev-bypass is for local runs and tests only; refusing to start in ${envName}`);
  }
  if (providers === 'vendors') throw new Error('POSTLY_PROVIDERS=vendors needs the vendor adapters (WP-41), which do not exist yet');
  if (!SIMULATED_ENVS.includes(envName)) {
    throw new Error(`POSTLY_PROVIDERS=simulators is not allowed in ${envName}: only local, test and dev may run on the simulators`);
  }
  // Real Gemini (agent.md, Running on dev): never in a test or a CI job, whatever else is set.
  if (models === 'vertex' && (envName === 'test' || realModelsRefused(env))) {
    throw new Error('POSTLY_MODELS=vertex is refused in tests and CI (agent.md, Testing without paying for a model)');
  }
  if (models === 'vertex' && !parsed.data.VERTEX_PROJECT) throw new Error('POSTLY_MODELS=vertex needs VERTEX_PROJECT');
  const agentFlows = parsed.data.POSTLY_AGENT_FLOWS === undefined ? undefined : parseAgentFlows(parsed.data.POSTLY_AGENT_FLOWS);
  const store = parsed.data.SIMULATOR_STORE ?? 'memory';
  if (envName === 'dev' && store !== 'postgres') {
    throw new Error('dev requires SIMULATOR_STORE=postgres: web, worker and the sandbox must share the simulator state');
  }
  if (store === 'postgres' && !env[passwordVar(SIMULATOR_LOGIN)]) throw new Error(`missing database password: ${passwordVar(SIMULATOR_LOGIN)}`);
  const secret = parsed.data.MESSAGING_WEBHOOK_SECRET;
  const deployed = !['local', 'test'].includes(parsed.data.POSTLY_ENV);
  if (deployed && !secret) throw new Error(`MESSAGING_WEBHOOK_SECRET is required in ${parsed.data.POSTLY_ENV}`);
  if (deployed && secret === SIMULATOR_WEBHOOK_SECRET) {
    throw new Error('MESSAGING_WEBHOOK_SECRET is the public simulator default; set a real secret in Secret Manager');
  }
  const consoleAuth = parsed.data.CONSOLE_AUTH ?? (deployed ? 'iap' : 'dev-bypass');
  const consoleConfig: ConsoleConfig =
    consoleAuth === 'dev-bypass'
      ? { auth: 'dev-bypass', devActor: parsed.data.CONSOLE_DEV_ACTOR }
      : {
          auth: 'iap',
          ...(parsed.data.CONSOLE_IAP_AUDIENCE ? { iapAudience: parsed.data.CONSOLE_IAP_AUDIENCE } : {}),
          ...(parsed.data.CONSOLE_HOST ? { host: parsed.data.CONSOLE_HOST } : {}),
        };
  const missing = logins.map(passwordVar).filter((name) => !env[name]);
  if (missing.length) throw new Error(`missing database passwords: ${missing.join(', ')}`);
  const passwordFor = (login: string) => env[passwordVar(login)]!;
  return {
    env: parsed.data.POSTLY_ENV,
    webhookSecret: secret || SIMULATOR_WEBHOOK_SECRET,
    databaseUrls: databaseUrls(parsed.data.DATABASE_URL, passwordFor, logins),
    jobsUrl: loginUrl(parsed.data.DATABASE_URL, JOBS_LOGIN, passwordFor(JOBS_LOGIN)),
    publicBaseUrl: parsed.data.PUBLIC_BASE_URL,
    businessNumber: parsed.data.BUSINESS_NUMBER,
    port: parsed.data.PORT,
    dbPoolMax: parsed.data.DB_POOL_MAX,
    maxConnections: poolConnections(logins, parsed.data.DB_POOL_MAX),
    console: consoleConfig,
    simulators: store === 'postgres' ? { store, storeUrl: loginUrl(parsed.data.DATABASE_URL, SIMULATOR_LOGIN, env[passwordVar(SIMULATOR_LOGIN)]!) } : { store },
    models,
    ...(models === 'vertex' ? { vertex: { project: parsed.data.VERTEX_PROJECT!, location: parsed.data.VERTEX_LOCATION } } : {}),
    ...(agentFlows ? { agentFlows } : {}),
    burstQuietMs: parsed.data.BURST_QUIET_MS ?? DEFAULT_BURST_QUIET_MS,
  };
}
