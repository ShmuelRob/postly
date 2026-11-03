import { describe, expect, it } from 'vitest';
import { ALL_LOGINS, BUSINESS_ROLES, JOBS_LOGIN, JOBS_SCHEMA, loginFor, passwordStatements, quoteLiteral, SYSTEM_PURPOSES } from './index.js';

describe('database provisioning (the migration job)', () => {
  it('covers every role login of the grant matrix plus the job queue login', () => {
    expect(ALL_LOGINS).toEqual([...BUSINESS_ROLES.map(loginFor), ...SYSTEM_PURPOSES.map(loginFor), JOBS_LOGIN]);
    expect(JOBS_LOGIN).toBe('app_jobs');
    expect(JOBS_SCHEMA).toBe('pgboss');
  });

  it('sets one password per login and quotes it as a literal', () => {
    const statements = passwordStatements((login) => `pw-${login}'x`);
    expect(statements).toHaveLength(ALL_LOGINS.length);
    expect(statements[0]).toBe(`alter role app_messaging password 'pw-app_messaging''x'`);
  });

  it('refuses an empty or missing password', () => {
    expect(() => passwordStatements(() => '')).toThrow('no password for app_messaging');
  });

  it('quotes backslashes and quotes safely', () => {
    expect(quoteLiteral(String.raw`a\'b`)).toBe(String.raw`E'a\\''b'`);
    expect(quoteLiteral('plain')).toBe(`'plain'`);
  });
});
