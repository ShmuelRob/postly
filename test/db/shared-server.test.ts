import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../../src/db/migrate.js';
import { databaseUrl, migrationsHash, runDatabaseName, runDatabaseTime, staleRunDatabases, templateName } from './shared-server.js';

// technical-design.md, "Local test database": the names and the template key of the shared test Postgres.

describe('run database names', () => {
  const now = new Date('2026-11-07T09:08:07.654Z');

  it('hold the worktree and a run id, in Postgres identifier characters, within 63 characters', () => {
    const name = runDatabaseName('peaceful-neumann-251e22', now, '0a1b2c3d');
    expect(name).toBe('postly_run_peaceful_neumann_251e22_20261107090807_0a1b2c3d');
    const long = runDatabaseName('A Very-Long Worktree Name That Goes On And On', now, 'ffffffff');
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z0-9_]+$/);
    expect(runDatabaseName('---', now, '00000000')).toBe('postly_run_run_20261107090807_00000000');
  });

  it('two worktrees, or two runs of one worktree, never get the same name', () => {
    expect(runDatabaseName('wt-a', now, '00000001')).not.toBe(runDatabaseName('wt-b', now, '00000001'));
    expect(runDatabaseName('wt-a', now, '00000001')).not.toBe(runDatabaseName('wt-a', now, '00000002'));
  });

  it('carry their creation time, read back to the second', () => {
    expect(runDatabaseTime(runDatabaseName('wt', now, 'abcdef01'))?.toISOString()).toBe('2026-11-07T09:08:07.000Z');
    expect(runDatabaseTime('postgres')).toBeUndefined();
    expect(runDatabaseTime('postly_tpl_0123456789ab')).toBeUndefined();
  });

  it('are stale after a day; other databases never are', () => {
    const names = [
      runDatabaseName('old', new Date(now.getTime() - 25 * 3600_000), 'aaaaaaaa'),
      runDatabaseName('new', new Date(now.getTime() - 23 * 3600_000), 'bbbbbbbb'),
      'postgres',
      'postly_tpl_0123456789ab',
    ];
    expect(staleRunDatabases(names, now)).toEqual([names[0]]);
  });

  it('give a URL with the same login on the same server', () => {
    expect(databaseUrl('postgres://postgres:pw@127.0.0.1:55432/postgres', 'postly_run_x')).toBe('postgres://postgres:pw@127.0.0.1:55432/postly_run_x');
  });
});

describe('the template key', () => {
  it('is a hash of drizzle/, which changes when a migration file changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    try {
      cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
      const before = migrationsHash(dir);
      expect(before).toBe(migrationsHash(MIGRATIONS_FOLDER));
      expect(before).toMatch(/^[0-9a-f]{12}$/);
      expect(templateName(before)).toBe(`postly_tpl_${before}`);
      writeFileSync(join(dir, '9999_next.sql'), 'select 1;');
      expect(migrationsHash(dir)).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores line endings, so a checkout with CRLF gets the same template', () => {
    const lf = mkdtempSync(join(tmpdir(), 'lf-'));
    const crlf = mkdtempSync(join(tmpdir(), 'crlf-'));
    try {
      writeFileSync(join(lf, '0000_a.sql'), 'a;\nb;\n');
      writeFileSync(join(crlf, '0000_a.sql'), 'a;\r\nb;\r\n');
      expect(migrationsHash(lf)).toBe(migrationsHash(crlf));
    } finally {
      rmSync(lf, { recursive: true, force: true });
      rmSync(crlf, { recursive: true, force: true });
    }
  });
});
