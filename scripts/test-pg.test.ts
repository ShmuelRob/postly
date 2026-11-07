import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTAINER, dockerRunArgs, IMAGE, LIMITS, SERVER_URL } from './test-pg.js';

// technical-design.md, "Local test database": one long-running container with CPU and memory limits.

describe('npm run test:pg', () => {
  it('starts postly-test-pg from postgres:17-alpine with CPU and memory limits, on 127.0.0.1 only', () => {
    const args = dockerRunArgs();
    expect(CONTAINER).toBe('postly-test-pg');
    expect(IMAGE).toBe('postgres:17-alpine');
    expect(args.slice(args.indexOf('--name'), args.indexOf('--name') + 2)).toEqual(['--name', 'postly-test-pg']);
    expect(args[args.indexOf('--cpus') + 1]).toBe(LIMITS.cpus);
    expect(args[args.indexOf('--memory') + 1]).toBe(LIMITS.memory);
    expect(args[args.indexOf('--publish') + 1]).toMatch(/^127\.0\.0\.1:\d+:5432$/);
    expect(args).toContain(IMAGE);
  });

  it('gives a superuser URL to the server, not to a database the runs use', () => {
    const url = new URL(SERVER_URL);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/postgres');
  });

  it('is wired as an npm script', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:pg']).toBe('node scripts/test-pg.ts');
  });
});
