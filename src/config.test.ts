import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { ALL_LOGINS } from './db/index.js';
import { SIMULATOR_WEBHOOK_SECRET } from './simulators/index.js';

const passwords = Object.fromEntries(ALL_LOGINS.map((l) => [`DB_PASSWORD_${l.toUpperCase()}`, `pw-${l}`]));
const base: Record<string, string> = {
  POSTLY_PROVIDERS: 'simulators',
  DATABASE_URL: 'postgres://db.internal:5432/postly',
  PUBLIC_BASE_URL: 'https://staging.example.test',
  BUSINESS_NUMBER: '+972500000000',
  ...passwords,
};

describe('process configuration', () => {
  it('builds one URL per role login from the server URL and the per-login passwords', () => {
    const config = loadConfig(base);
    expect(config.databaseUrls.business.messaging).toBe('postgres://app_messaging:pw-app_messaging@db.internal:5432/postly');
    expect(config.databaseUrls.system.scheduler).toContain('app_sys_scheduler:pw-app_sys_scheduler@');
    expect(config.jobsUrl).toContain('app_jobs:pw-app_jobs@');
    expect(config.port).toBe(8080);
  });

  it('refuses a missing login password instead of falling back to another login', () => {
    const { DB_PASSWORD_APP_BILLING: _, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow('DB_PASSWORD_APP_BILLING');
  });

  it('runs only on the simulators until the vendor adapters exist (WP-41)', () => {
    expect(() => loadConfig({ ...base, POSTLY_PROVIDERS: 'live' })).toThrow('POSTLY_PROVIDERS');
  });

  it('refuses a database URL that carries its own user', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: 'postgres://admin:x@db:5432/postly' })).toThrow('no user');
  });

  describe('webhook secret', () => {
    it('lets a local run use the public simulator secret', () => {
      expect(loadConfig(base).webhookSecret).toBe(SIMULATOR_WEBHOOK_SECRET);
      expect(loadConfig({ ...base, POSTLY_ENV: 'test' }).webhookSecret).toBe(SIMULATOR_WEBHOOK_SECRET);
    });

    it('reads the secret from the environment (Secret Manager on Cloud Run)', () => {
      expect(loadConfig({ ...base, POSTLY_ENV: 'staging', MESSAGING_WEBHOOK_SECRET: 's3cret-from-manager' }).webhookSecret).toBe('s3cret-from-manager');
    });

    it('refuses to start in staging or prod without a secret', () => {
      expect(() => loadConfig({ ...base, POSTLY_ENV: 'staging' })).toThrow('MESSAGING_WEBHOOK_SECRET');
      expect(() => loadConfig({ ...base, POSTLY_ENV: 'prod', MESSAGING_WEBHOOK_SECRET: '' })).toThrow('MESSAGING_WEBHOOK_SECRET');
    });

    it('refuses the public default secret in staging or prod', () => {
      expect(() => loadConfig({ ...base, POSTLY_ENV: 'prod', MESSAGING_WEBHOOK_SECRET: SIMULATOR_WEBHOOK_SECRET })).toThrow('public');
    });

    it('refuses an unknown environment', () => {
      expect(() => loadConfig({ ...base, POSTLY_ENV: 'production' })).toThrow('POSTLY_ENV');
    });
  });
});
