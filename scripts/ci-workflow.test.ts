// The CI path filter must never let tests be skipped into a passing `check` (docs/deployment.md#ci).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ci = readFileSync('.github/workflows/ci.yml', 'utf8').replaceAll('\r', '');
const infra = readFileSync('.github/workflows/infra.yml', 'utf8').replaceAll('\r', '');
const job = (name: string, file = ci) => {
  const start = file.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = file.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

describe('ci.yml path filter', () => {
  it('a changes job runs the lane script on the PR diff, and says not docs-only outside a PR', () => {
    const changes = job('changes');
    expect(changes).toContain('fetch-depth: 0');
    expect(changes).toContain('node scripts/lane.ts --base "${{ github.event.pull_request.base.sha }}" --github-output "$GITHUB_OUTPUT"');
    expect(changes).toMatch(/"\$\{\{ github\.event_name \}\}" != 'pull_request' \]; then echo docs_only=false/);
    expect(changes).toContain('docs_only: ${{ steps.lane.outputs.docs_only }}');
  });

  it('static always runs and checks the review queue; tests skip only on docs-only', () => {
    expect(job('static')).not.toMatch(/\n {4}if:/);
    expect(job('static')).toContain('npm run lint:review-queue');
    const tests = job('tests');
    expect(tests).toContain('needs: changes');
    expect(tests).toContain("if: needs.changes.outputs.docs_only != 'true'");
  });

  it('check accepts skipped tests only when changes passed and said docs-only', () => {
    const check = job('check');
    expect(check).toContain('if: always()');
    expect(check).toMatch(/needs: \[changes, static, tests\]/);
    expect(check).toContain('test "${{ needs.changes.result }}" = success');
    expect(check).toContain('test "${{ needs.static.result }}" = success');
    expect(check).toContain(
      `test "\${{ needs.tests.result }}" = success || { test "\${{ needs.tests.result }}" = skipped && test "\${{ needs.changes.outputs.docs_only }}" = true; }`,
    );
  });
});

describe('infra.yml aggregate', () => {
  it('infra-check needs every Infra job, always runs, and passes only on success or skipped', () => {
    const check = job('infra-check', infra);
    expect(check).toContain('if: always()');
    expect(check).toMatch(/needs: \[changes, image, terraform\]/);
    expect(check).toContain('test "${{ needs.changes.result }}" = success');
    for (const j of ['image', 'terraform']) {
      expect(check).toContain(`case "\${{ needs.${j}.result }}" in success|skipped) ;; *) exit 1 ;; esac`);
    }
  });
});
