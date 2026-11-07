import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// implementation-plan.md, Lanes, "Migrations: one in flight, generated last": CI's static job runs
// `npm run db:check` (`drizzle-kit check`), which fails when the snapshot chain in drizzle/meta is broken,
// as when two branches each generated a migration on the same parent snapshot.

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const drizzleKit = fileURLToPath(new URL('../../node_modules/drizzle-kit/bin.cjs', import.meta.url));

/** Runs `drizzle-kit check` on a migrations folder, given relative to the repository root. */
function check(out: string) {
  // A relative --out: drizzle-kit joins an absolute Windows path onto the working directory.
  return spawnSync(process.execPath, [drizzleKit, 'check', '--dialect', 'postgresql', '--out', out], { cwd: repoRoot, encoding: 'utf8' });
}

describe('drizzle-kit check on the snapshot chain', { timeout: 60_000 }, () => {
  it('passes on a chain where every snapshot has its own parent', () => {
    const result = check('test/fixtures/drizzle-check/ok');
    expect(result.stdout + result.stderr).toContain("Everything's fine");
    expect(result.status).toBe(0);
  });

  it('fails when two snapshots point at the same parent (two migrations generated in parallel)', () => {
    const result = check('test/fixtures/drizzle-check/collision');
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/collision/i);
  });

  it("passes on the repository's own drizzle/", () => {
    const result = check('drizzle');
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});

describe('the check is wired into CI', () => {
  it('package.json has db:check running drizzle-kit check', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['db:check']).toBe('drizzle-kit check');
  });

  it("the static job in ci.yml runs it", () => {
    const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').replaceAll('\r', '');
    const staticJob = ci.slice(ci.indexOf('\n  static:'), ci.indexOf('\n  tests:'));
    expect(staticJob).toContain('- run: npm run db:check');
  });
});
