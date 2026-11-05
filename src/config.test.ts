import { describe, expect, it } from 'vitest';
import { loadConfig, PROCESS_LOGINS } from './config.js';
import { ALL_LOGINS } from './db/index.js';
import { SIMULATOR_WEBHOOK_SECRET } from './simulators/index.js';

const passwords = Object.fromEntries(ALL_LOGINS.map((l) => [`DB_PASSWORD_${l.toUpperCase()}`, `pw-${l}`]));
const base: Record<string, string> = {
  POSTLY_ENV: 'local',
  POSTLY_PROVIDERS: 'simulators',
  DATABASE_URL: 'postgres://db.internal:5432/postly',
  PUBLIC_BASE_URL: 'https://stage.example.test',
  BUSINESS_NUMBER: '+972500000000',
  ...passwords,
};

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
      expect(loadConfig({ ...base, POSTLY_ENV: 'stage', MESSAGING_WEBHOOK_SECRET: 's3cret-from-manager' }).webhookSecret).toBe('s3cret-from-manager');
    });

    it('refuses to start in dev, stage or prod without a secret', () => {
      expect(() => loadConfig({ ...base, POSTLY_ENV: 'dev' })).toThrow('MESSAGING_WEBHOOK_SECRET');
      expect(() => loadConfig({ ...base, POSTLY_ENV: 'stage' })).toThrow('MESSAGING_WEBHOOK_SECRET');
      expect(() => loadConfig({ ...base, POSTLY_ENV: 'prod', MESSAGING_WEBHOOK_SECRET: '' })).toThrow('MESSAGING_WEBHOOK_SECRET');
    });

    it('refuses the public default secret in dev, stage or prod', () => {
      expect(() => loadConfig({ ...base, POSTLY_ENV: 'dev', MESSAGING_WEBHOOK_SECRET: SIMULATOR_WEBHOOK_SECRET })).toThrow('public');
      expect(() => loadConfig({ ...base, POSTLY_ENV: 'prod', MESSAGING_WEBHOOK_SECRET: SIMULATOR_WEBHOOK_SECRET })).toThrow('public');
    });

    it('refuses to start without POSTLY_ENV, so a deployed service never falls back to the public secret', () => {
      const { POSTLY_ENV: _, ...rest } = base;
      expect(() => loadConfig(rest)).toThrow('POSTLY_ENV');
      expect(() => loadConfig({ ...rest, MESSAGING_WEBHOOK_SECRET: SIMULATOR_WEBHOOK_SECRET })).toThrow('POSTLY_ENV');
    });

    it('refuses an unknown environment', () => {
      expect(() => loadConfig({ ...base, POSTLY_ENV: 'production' })).toThrow('POSTLY_ENV');
      expect(() => loadConfig({ ...base, POSTLY_ENV: 'staging' })).toThrow('POSTLY_ENV');
    });
  });
});
