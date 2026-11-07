import { describe, expect, it } from 'vitest';
import { loadConfig, PROCESS_LOGINS } from './config.js';
import { ALL_LOGINS, SIMULATOR_LOGIN } from './db/index.js';
import { SIMULATOR_WEBHOOK_SECRET } from './simulators/index.js';

const passwords = Object.fromEntries(ALL_LOGINS.map((l) => [`DB_PASSWORD_${l.toUpperCase()}`, `pw-${l}`]));
const base: Record<string, string> = {
  POSTLY_ENV: 'local',
  POSTLY_PROVIDERS: 'simulators',
  DATABASE_URL: 'postgres://db.internal:5432/postly',
  PUBLIC_BASE_URL: 'https://dev.example.test',
  BUSINESS_NUMBER: '+972500000000',
  ...passwords,
};
/** A deployed dev on the simulators (WP-51): the Postgres store and its login's password. */
const dev: Record<string, string> = {
  ...base,
  POSTLY_ENV: 'dev',
  MESSAGING_WEBHOOK_SECRET: 's3cret-from-manager',
  SIMULATOR_STORE: 'postgres',
  DB_PASSWORD_APP_SIMULATOR: 'test-only',
  VERTEX_PROJECT: 'postly-dev-test',
};
const without = (env: Record<string, string>, name: string) => Object.fromEntries(Object.entries(env).filter(([k]) => k !== name));

describe('per-process logins (D9, WP-84)', () => {
  it('the console process needs only its own logins, and gets URLs for nothing else', () => {
    const only = Object.fromEntries(PROCESS_LOGINS.console.map((l) => [`DB_PASSWORD_${l.toUpperCase()}`, `pw-${l}`]));
    const withoutPasswords = Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith('DB_PASSWORD_')));
    const config = loadConfig({ ...withoutPasswords, ...only }, 'console');
    expect(config.databaseUrls.system.console).toContain('app_sys_console:');
    expect(config.databaseUrls.business.model).toBeUndefined();
    expect(config.databaseUrls.system.example_set).toBeUndefined();
    expect(PROCESS_LOGINS.console.length).toBeLessThan(ALL_LOGINS.length);
  });

  it('a process still refuses a missing password among its own logins', () => {
    const { DB_PASSWORD_APP_SYS_CONSOLE: _gone, ...rest } = base;
    expect(() => loadConfig(rest, 'console')).toThrow('DB_PASSWORD_APP_SYS_CONSOLE');
  });

  it('a dev console on the Postgres simulator store needs that store login too, and nothing else extra', () => {
    const only = Object.fromEntries(PROCESS_LOGINS.console.map((l) => [`DB_PASSWORD_${l.toUpperCase()}`, `pw-${l}`]));
    const withoutPasswords = Object.fromEntries(Object.entries(dev).filter(([k]) => !k.startsWith('DB_PASSWORD_')));
    expect(() => loadConfig({ ...withoutPasswords, ...only }, 'console')).toThrow(`DB_PASSWORD_${SIMULATOR_LOGIN.toUpperCase()}`);
    const config = loadConfig({ ...withoutPasswords, ...only, [`DB_PASSWORD_${SIMULATOR_LOGIN.toUpperCase()}`]: 'test-only' }, 'console');
    expect(config.simulators.store).toBe('postgres');
  });

  it('web and worker still load every login until they are narrowed', () => {
    expect([...PROCESS_LOGINS.web].sort()).toEqual([...ALL_LOGINS].sort());
    expect([...PROCESS_LOGINS.worker].sort()).toEqual([...ALL_LOGINS].sort());
  });
});

describe('process configuration', () => {
  it('builds one URL per role login from the server URL and the per-login passwords', () => {
    const config = loadConfig(base);
    expect(config.databaseUrls.business.messaging).toBe('postgres://app_messaging:pw-app_messaging@db.internal:5432/postly');
    expect(config.databaseUrls.system.scheduler).toContain('app_sys_scheduler:pw-app_sys_scheduler@');
    expect(config.jobsUrl).toContain('app_jobs:pw-app_jobs@');
    expect(config.port).toBe(8080);
  });

  it('refuses a missing login password instead of falling back to another login', () => {
    expect(() => loadConfig(without(base, 'DB_PASSWORD_APP_BILLING'))).toThrow('DB_PASSWORD_APP_BILLING');
  });

  it('runs only on the simulators until the vendor adapters exist (WP-41)', () => {
    expect(() => loadConfig({ ...base, POSTLY_PROVIDERS: 'live' })).toThrow('POSTLY_PROVIDERS');
    expect(() => loadConfig({ ...base, POSTLY_PROVIDERS: 'vendors' })).toThrow('WP-41');
  });

  it('refuses a database URL that carries its own user', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: 'postgres://admin:x@db:5432/postly' })).toThrow('no user');
  });

  describe('simulated mode (WP-51)', () => {
    it('refuses the simulators in stage and prod, at startup', () => {
      for (const env of ['stage', 'prod']) {
        expect(() => loadConfig({ ...dev, POSTLY_ENV: env })).toThrow(`POSTLY_PROVIDERS=simulators is not allowed in ${env}`);
        expect(() => loadConfig({ ...dev, POSTLY_ENV: env, SIMULATOR_STORE: 'memory' })).toThrow('not allowed');
      }
    });

    it('allows the simulators in local, test and dev', () => {
      expect(loadConfig(base).simulators).toEqual({ store: 'memory' });
      expect(loadConfig({ ...base, POSTLY_ENV: 'test' }).simulators).toEqual({ store: 'memory' });
      expect(loadConfig(dev).simulators).toEqual({
        store: 'postgres',
        storeUrl: `postgres://${SIMULATOR_LOGIN}:test-only@db.internal:5432/postly`,
      });
    });

    it('requires the shared Postgres store in dev, so web, worker and the sandbox see one outside world', () => {
      expect(() => loadConfig({ ...dev, SIMULATOR_STORE: 'memory' })).toThrow('SIMULATOR_STORE=postgres');
      expect(() => loadConfig(without(dev, 'SIMULATOR_STORE'))).toThrow('SIMULATOR_STORE=postgres');
      expect(() => loadConfig(without(dev, 'DB_PASSWORD_APP_SIMULATOR'))).toThrow('DB_PASSWORD_APP_SIMULATOR');
    });

    it('runs local and test on the model simulator, with no switch that changes it', () => {
      expect(loadConfig(base).models).toBe('simulator');
      expect(loadConfig(base).vertex).toBeUndefined();
      // POSTLY_MODELS is gone (agent.md, Running on dev): setting it changes nothing.
      expect(loadConfig({ ...base, POSTLY_MODELS: 'vertex', VERTEX_PROJECT: 'p' }).models).toBe('simulator');
    });
  });

  // agent.md, Running on dev: every deployed environment runs on real Gemini, with no switch.
  describe('Vertex AI in every deployed environment', () => {
    const vertex = { ...dev, VERTEX_LOCATION: 'eu' };

    it('runs dev on Vertex with the project and location from the environment, and POSTLY_MODELS cannot turn it off', () => {
      const config = loadConfig(vertex);
      expect(config.models).toBe('vertex');
      expect(config.vertex).toEqual({ project: 'postly-dev-test', location: 'eu' });
      expect(loadConfig({ ...vertex, POSTLY_MODELS: 'simulator' }).models).toBe('vertex');
    });

    it('defaults the location to the EU multi-region (Gemini 3.5 Flash-Lite is not served from single regions)', () => {
      expect(loadConfig(without(vertex, 'VERTEX_LOCATION')).vertex).toEqual({ project: 'postly-dev-test', location: 'eu' });
    });

    it('accepts global, the eu and us multi-regions and single regions, and nothing else', () => {
      for (const location of ['global', 'eu', 'us', 'europe-west4']) {
        expect(loadConfig({ ...vertex, VERTEX_LOCATION: location }).vertex?.location).toBe(location);
      }
      for (const location of ['EU', 'asia', 'eu.rep', '']) {
        expect(() => loadConfig({ ...vertex, VERTEX_LOCATION: location })).toThrow('VERTEX_LOCATION');
      }
    });

    it('needs the project', () => {
      expect(() => loadConfig(without(vertex, 'VERTEX_PROJECT'))).toThrow('VERTEX_PROJECT');
    });

    it('refuses to start a deployed environment in tests and CI, so no test reaches a paid model', () => {
      expect(() => loadConfig({ ...vertex, NODE_ENV: 'test' })).toThrow('refused in tests and CI');
      expect(() => loadConfig({ ...vertex, CI: 'true' })).toThrow('refused in tests and CI');
      expect(loadConfig({ ...vertex, POSTLY_ENV: 'test', SIMULATOR_STORE: 'memory' }).models).toBe('simulator');
    });
  });

  // agent.md, Running on dev: the agents always run; there is no flow switch to read.
  it('reads no agent flow switch', () => {
    expect(loadConfig({ ...dev, POSTLY_AGENT_FLOWS: 'none' })).not.toHaveProperty('agentFlows');
  });

  // technical-design.md, Operational defaults: the burst quiet window per environment.
  describe('burst quiet window (BURST_QUIET_MS)', () => {
    it('defaults to 20 seconds', () => {
      expect(loadConfig(dev).burstQuietMs).toBe(20_000);
    });

    it('takes a whole number of milliseconds from 500 to 60000', () => {
      expect(loadConfig({ ...dev, BURST_QUIET_MS: '2000' }).burstQuietMs).toBe(2000);
      expect(loadConfig({ ...dev, BURST_QUIET_MS: '500' }).burstQuietMs).toBe(500);
      expect(loadConfig({ ...dev, BURST_QUIET_MS: '60000' }).burstQuietMs).toBe(60_000);
    });

    it('refuses a value outside that range or not a whole number', () => {
      for (const v of ['0', '499', '60001', '2.5', 'fast']) expect(() => loadConfig({ ...dev, BURST_QUIET_MS: v })).toThrow('BURST_QUIET_MS');
    });
  });

  describe('webhook secret', () => {
    it('lets a local run use the public simulator secret', () => {
      expect(loadConfig(base).webhookSecret).toBe(SIMULATOR_WEBHOOK_SECRET);
      expect(loadConfig({ ...base, POSTLY_ENV: 'test' }).webhookSecret).toBe(SIMULATOR_WEBHOOK_SECRET);
    });

    it('reads the secret from the environment (Secret Manager on Cloud Run)', () => {
      expect(loadConfig(dev).webhookSecret).toBe('s3cret-from-manager');
    });

    it('refuses to start in dev without a secret', () => {
      expect(() => loadConfig(without(dev, 'MESSAGING_WEBHOOK_SECRET'))).toThrow('MESSAGING_WEBHOOK_SECRET');
      expect(() => loadConfig({ ...dev, MESSAGING_WEBHOOK_SECRET: '' })).toThrow('MESSAGING_WEBHOOK_SECRET');
    });

    it('refuses the public default secret in dev', () => {
      expect(() => loadConfig({ ...dev, MESSAGING_WEBHOOK_SECRET: SIMULATOR_WEBHOOK_SECRET })).toThrow('public');
    });

    it('refuses to start without POSTLY_ENV, so a deployed service never falls back to the public secret', () => {
      const rest = without(base, 'POSTLY_ENV');
      expect(() => loadConfig(rest)).toThrow('POSTLY_ENV');
      expect(() => loadConfig({ ...rest, MESSAGING_WEBHOOK_SECRET: SIMULATOR_WEBHOOK_SECRET })).toThrow('POSTLY_ENV');
    });

    it('refuses an unknown environment', () => {
      expect(() => loadConfig({ ...base, POSTLY_ENV: 'production' })).toThrow('POSTLY_ENV');
      expect(() => loadConfig({ ...base, POSTLY_ENV: 'staging' })).toThrow('POSTLY_ENV');
    });
  });

  describe('console sign-in (WP-82, docs/security.md)', () => {
    const deployed = { ...base, POSTLY_ENV: 'stage', MESSAGING_WEBHOOK_SECRET: 'real-secret' };
    const AUDIENCE = '/projects/123456789012/global/backendServices/4567890123456789';

    it('uses the dev bypass locally and in tests, with a default local actor', () => {
      expect(loadConfig(base).console).toEqual({ auth: 'dev-bypass', devActor: 'local-dev' });
      expect(loadConfig({ ...base, POSTLY_ENV: 'test', CONSOLE_DEV_ACTOR: 'me@local' }).console).toEqual({ auth: 'dev-bypass', devActor: 'me@local' });
    });

    it('uses IAP when deployed, with the audience and host from Terraform', () => {
      const config = loadConfig({ ...dev, CONSOLE_IAP_AUDIENCE: AUDIENCE, CONSOLE_HOST: 'console.example.com' });
      expect(config.console).toEqual({ auth: 'iap', iapAudience: AUDIENCE, host: 'console.example.com' });
      expect(loadConfig(dev).console).toEqual({ auth: 'iap' });
    });

    // Checked before anything else, so it holds even while stage and prod refuse the simulators (WP-51).
    it('refuses to start with the dev bypass in stage or prod', () => {
      for (const env of ['stage', 'prod']) {
        expect(() => loadConfig({ ...deployed, POSTLY_ENV: env, CONSOLE_AUTH: 'dev-bypass' }), env).toThrow(/dev-bypass/);
      }
    });

    it('allows IAP locally, for trying the sign-in', () => {
      expect(loadConfig({ ...base, CONSOLE_AUTH: 'iap', CONSOLE_IAP_AUDIENCE: AUDIENCE }).console).toEqual({ auth: 'iap', iapAudience: AUDIENCE });
    });

    it('accepts the audience Cloud Run’s built-in IAP signs, with the run.app host (dev)', () => {
      const cloudRun = '/projects/123456789012/locations/me-west1/services/postly-dev-console';
      const host = 'postly-dev-console-123456789012.me-west1.run.app';
      expect(loadConfig({ ...dev, CONSOLE_IAP_AUDIENCE: cloudRun, CONSOLE_HOST: host }).console).toEqual({ auth: 'iap', iapAudience: cloudRun, host });
    });

    it('refuses an audience that is not a backend service path, and an unknown mode', () => {
      expect(() => loadConfig({ ...dev, CONSOLE_IAP_AUDIENCE: 'postly-console' })).toThrow('CONSOLE_IAP_AUDIENCE');
      expect(() => loadConfig({ ...base, CONSOLE_AUTH: 'none' })).toThrow('CONSOLE_AUTH');
    });
  });
});

describe('BUSINESS_NUMBER', () => {
  it('refuses a value that is not E.164, naming the variable', () => {
    for (const bad of ['+0000000000', '0500000000', 'not-a-number', '+972 50 000 0000']) {
      expect(() => loadConfig({ ...base, BUSINESS_NUMBER: bad })).toThrow(/BUSINESS_NUMBER/);
    }
  });

  it('accepts a made-up E.164 number', () => {
    expect(loadConfig({ ...base, BUSINESS_NUMBER: '+15550000001' }).businessNumber).toBe('+15550000001');
  });
});

// docs/observability.md, "Log level": LOG_LEVEL, debug only where no customer runs.
describe('LOG_LEVEL', () => {
  it('defaults to info and accepts debug, info, warn and error', () => {
    expect(loadConfig(base).logLevel).toBe('info');
    for (const level of ['debug', 'info', 'warn', 'error'] as const) expect(loadConfig({ ...base, LOG_LEVEL: level }).logLevel).toBe(level);
    expect(loadConfig({ ...dev, LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('refuses debug in stage and prod, at startup', () => {
    for (const env of ['stage', 'prod']) expect(() => loadConfig({ ...dev, POSTLY_ENV: env, LOG_LEVEL: 'debug' })).toThrow(/LOG_LEVEL=debug is allowed only in local, test and dev/);
  });
});
