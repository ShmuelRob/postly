import { z } from 'zod';
import { ALL_LOGINS, type DatabaseUrls, databaseUrls, JOBS_LOGIN } from './db/index.js';

// Process configuration from the environment (docs/deployment.md). On Cloud Run each password is a
// Secret Manager secret mounted as an environment variable; locally docker-compose sets them.

const Env = z.object({
  /** Only `simulators` until the vendor adapters land (WP-41); staging and prod wait for that. */
  POSTLY_PROVIDERS: z.literal('simulators', { error: 'POSTLY_PROVIDERS must be "simulators" until WP-41 adds the vendor adapters' }),
  /** The server and database, with no user or password: each login gets its own. */
  DATABASE_URL: z.url().refine((u) => new URL(u).username === '', 'DATABASE_URL must have no user; each role login is built from it'),
  PUBLIC_BASE_URL: z.url(),
  BUSINESS_NUMBER: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8080),
});

export interface Config {
  databaseUrls: DatabaseUrls;
  jobsUrl: string;
  publicBaseUrl: string;
  businessNumber: string;
  port: number;
}

export const passwordVar = (login: string) => `DB_PASSWORD_${login.toUpperCase()}`;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration: ${z.prettifyError(parsed.error)}`);
  const missing = ALL_LOGINS.map(passwordVar).filter((name) => !env[name]);
  if (missing.length) throw new Error(`missing database passwords: ${missing.join(', ')}`);
  const passwordFor = (login: string) => env[passwordVar(login)]!;
  const jobs = new URL(parsed.data.DATABASE_URL);
  jobs.username = JOBS_LOGIN;
  jobs.password = passwordFor(JOBS_LOGIN);
  return {
    databaseUrls: databaseUrls(parsed.data.DATABASE_URL, passwordFor),
    jobsUrl: jobs.toString(),
    publicBaseUrl: parsed.data.PUBLIC_BASE_URL,
    businessNumber: parsed.data.BUSINESS_NUMBER,
    port: parsed.data.PORT,
  };
}
