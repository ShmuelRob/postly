import { z } from 'zod';
import { ALL_LOGINS, type DatabaseUrls, databaseUrls, JOBS_LOGIN, SIMULATOR_LOGIN } from './db/index.js';
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
  /** The model provider: the model simulator, or Gemini through Vertex AI (T5). */
  POSTLY_MODELS: z.enum(['simulator', 'vertex'], { error: 'POSTLY_MODELS must be "simulator" or "vertex"' }).default('simulator'),
  /** The server and database, with no user or password: each login gets its own. */
  DATABASE_URL: z.url().refine((u) => new URL(u).username === '', 'DATABASE_URL must have no user; each role login is built from it'),
  PUBLIC_BASE_URL: z.url(),
  BUSINESS_NUMBER: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8080),
});

export interface Config {
  env: 'local' | 'test' | 'dev' | 'stage' | 'prod';
  webhookSecret: string;
  databaseUrls: DatabaseUrls;
  jobsUrl: string;
  publicBaseUrl: string;
  businessNumber: string;
  port: number;
  /** Simulated mode (WP-51): where the simulators keep their state. */
  simulators: { store: 'memory' } | { store: 'postgres'; storeUrl: string };
  models: 'simulator' | 'vertex';
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

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration: ${z.prettifyError(parsed.error)}`);
  const { POSTLY_ENV: envName, POSTLY_PROVIDERS: providers, POSTLY_MODELS: models } = parsed.data;
  if (providers === 'vendors') throw new Error('POSTLY_PROVIDERS=vendors needs the vendor adapters (WP-41), which do not exist yet');
  if (!SIMULATED_ENVS.includes(envName)) {
    throw new Error(`POSTLY_PROVIDERS=simulators is not allowed in ${envName}: only local, test and dev may run on the simulators`);
  }
  if (models === 'vertex') throw new Error('POSTLY_MODELS=vertex: the T5 Vertex AI adapter is not wired into the simulated composition yet');
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
  const missing = ALL_LOGINS.map(passwordVar).filter((name) => !env[name]);
  if (missing.length) throw new Error(`missing database passwords: ${missing.join(', ')}`);
  const passwordFor = (login: string) => env[passwordVar(login)]!;
  return {
    env: parsed.data.POSTLY_ENV,
    webhookSecret: secret || SIMULATOR_WEBHOOK_SECRET,
    databaseUrls: databaseUrls(parsed.data.DATABASE_URL, passwordFor),
    jobsUrl: loginUrl(parsed.data.DATABASE_URL, JOBS_LOGIN, passwordFor(JOBS_LOGIN)),
    publicBaseUrl: parsed.data.PUBLIC_BASE_URL,
    businessNumber: parsed.data.BUSINESS_NUMBER,
    port: parsed.data.PORT,
    simulators: store === 'postgres' ? { store, storeUrl: loginUrl(parsed.data.DATABASE_URL, SIMULATOR_LOGIN, env[passwordVar(SIMULATOR_LOGIN)]!) } : { store },
    models,
  };
}
