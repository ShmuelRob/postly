import { z } from 'zod';
import { ALL_LOGINS, type DatabaseUrls, databaseUrls, JOBS_LOGIN } from './db/index.js';
import { IAP_AUDIENCE_PATTERN } from './modules/console/index.js';
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
  /** Console sign-in (docs/security.md, "Console exposure"): IAP when deployed, the dev bypass locally. */
  CONSOLE_AUTH: z.enum(['iap', 'dev-bypass'], { error: 'CONSOLE_AUTH must be iap or dev-bypass' }).optional(),
  /** From Terraform: the console backend service the IAP assertion must name. */
  CONSOLE_IAP_AUDIENCE: z.string().regex(IAP_AUDIENCE_PATTERN, 'CONSOLE_IAP_AUDIENCE must be /projects/<number>/global/backendServices/<id>').optional(),
  /** From Terraform: the console's domain; any other Host is refused. */
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
  console: ConsoleConfig;
}

export const passwordVar = (login: string) => `DB_PASSWORD_${login.toUpperCase()}`;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration: ${z.prettifyError(parsed.error)}`);
  const secret = parsed.data.MESSAGING_WEBHOOK_SECRET;
  const deployed = !['local', 'test'].includes(parsed.data.POSTLY_ENV);
  if (deployed && !secret) throw new Error(`MESSAGING_WEBHOOK_SECRET is required in ${parsed.data.POSTLY_ENV}`);
  if (deployed && secret === SIMULATOR_WEBHOOK_SECRET) {
    throw new Error('MESSAGING_WEBHOOK_SECRET is the public simulator default; set a real secret in Secret Manager');
  }
  const consoleAuth = parsed.data.CONSOLE_AUTH ?? (deployed ? 'iap' : 'dev-bypass');
  if (consoleAuth === 'dev-bypass' && (parsed.data.POSTLY_ENV === 'stage' || parsed.data.POSTLY_ENV === 'prod')) {
    throw new Error(`CONSOLE_AUTH=dev-bypass is for local runs and tests only; refusing to start in ${parsed.data.POSTLY_ENV}`);
  }
  const consoleConfig: ConsoleConfig =
    consoleAuth === 'dev-bypass'
      ? { auth: 'dev-bypass', devActor: parsed.data.CONSOLE_DEV_ACTOR }
      : {
          auth: 'iap',
          ...(parsed.data.CONSOLE_IAP_AUDIENCE ? { iapAudience: parsed.data.CONSOLE_IAP_AUDIENCE } : {}),
          ...(parsed.data.CONSOLE_HOST ? { host: parsed.data.CONSOLE_HOST } : {}),
        };
  const missing = ALL_LOGINS.map(passwordVar).filter((name) => !env[name]);
  if (missing.length) throw new Error(`missing database passwords: ${missing.join(', ')}`);
  const passwordFor = (login: string) => env[passwordVar(login)]!;
  const jobs = new URL(parsed.data.DATABASE_URL);
  jobs.username = JOBS_LOGIN;
  jobs.password = passwordFor(JOBS_LOGIN);
  return {
    env: parsed.data.POSTLY_ENV,
    webhookSecret: secret || SIMULATOR_WEBHOOK_SECRET,
    databaseUrls: databaseUrls(parsed.data.DATABASE_URL, passwordFor),
    jobsUrl: jobs.toString(),
    publicBaseUrl: parsed.data.PUBLIC_BASE_URL,
    businessNumber: parsed.data.BUSINESS_NUMBER,
    port: parsed.data.PORT,
    console: consoleConfig,
  };
}
