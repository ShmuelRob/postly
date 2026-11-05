import { z } from 'zod';
import { type DatabaseUrls, databaseUrls, JOBS_LOGIN, poolConnections, PROCESS_LOGINS } from './db/index.js';

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
  /** Only `simulators` until the vendor adapters land (WP-41); dev, stage and prod wait for that. */
  POSTLY_PROVIDERS: z.literal('simulators', { error: 'POSTLY_PROVIDERS must be "simulators" until WP-41 adds the vendor adapters' }),
  /** The server and database, with no user or password: each login gets its own. */
  DATABASE_URL: z.url().refine((u) => new URL(u).username === '', 'DATABASE_URL must have no user; each role login is built from it'),
  PUBLIC_BASE_URL: z.url(),
  BUSINESS_NUMBER: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8080),
  /** Connections per database login in this process (docs/security.md, D7); Terraform sets it from its budget. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(10).default(3),
});

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
}

export const passwordVar = (login: string) => `DB_PASSWORD_${login.toUpperCase()}`;

/** `process` limits the passwords read to that process's logins (docs/security.md, D9); web by default. */
export function loadConfig(env: Record<string, string | undefined>, process: keyof typeof PROCESS_LOGINS = 'web'): Config {
  const logins = PROCESS_LOGINS[process];
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration: ${z.prettifyError(parsed.error)}`);
  const secret = parsed.data.MESSAGING_WEBHOOK_SECRET;
  const deployed = !['local', 'test'].includes(parsed.data.POSTLY_ENV);
  if (deployed && !secret) throw new Error(`MESSAGING_WEBHOOK_SECRET is required in ${parsed.data.POSTLY_ENV}`);
  if (deployed && secret === SIMULATOR_WEBHOOK_SECRET) {
    throw new Error('MESSAGING_WEBHOOK_SECRET is the public simulator default; set a real secret in Secret Manager');
  }
  const missing = logins.map(passwordVar).filter((name) => !env[name]);
  if (missing.length) throw new Error(`missing database passwords: ${missing.join(', ')}`);
  const passwordFor = (login: string) => env[passwordVar(login)]!;
  const jobs = new URL(parsed.data.DATABASE_URL);
  jobs.username = JOBS_LOGIN;
  jobs.password = passwordFor(JOBS_LOGIN);
  return {
    env: parsed.data.POSTLY_ENV,
    webhookSecret: secret || SIMULATOR_WEBHOOK_SECRET,
    databaseUrls: databaseUrls(parsed.data.DATABASE_URL, passwordFor, logins),
    jobsUrl: jobs.toString(),
    publicBaseUrl: parsed.data.PUBLIC_BASE_URL,
    businessNumber: parsed.data.BUSINESS_NUMBER,
    port: parsed.data.PORT,
    dbPoolMax: parsed.data.DB_POOL_MAX,
    maxConnections: poolConnections(logins, parsed.data.DB_POOL_MAX),
  };
}
