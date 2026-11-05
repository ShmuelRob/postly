import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// database-schema.md, "Accepted risk": inside withBusiness() a transaction could still change its
// own session state, most of all app.business_id, or leave a temporary table on the pooled connection. Postgres cannot forbid that, so no code outside
// src/db/ may contain SQL that sets roles, settings, or session state.

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const BANNED: { name: string; pattern: RegExp }[] = [
  { name: 'set role/local/session', pattern: /\bset\s+(role|local|session)\b/i },
  { name: 'set app.*', pattern: /\bset\s+"?app\./i },
  { name: 'reset', pattern: /\breset\s+(role|all|session|"?app\.)/i },
  { name: 'set_config', pattern: /\bset_config\s*\(/i },
  { name: 'create temp', pattern: /\bcreate\s+(temp|temporary)\b/i },
  { name: 'discard', pattern: /\bdiscard\s+(all|plans|sequences|temp|temporary)\b/i },
  // Dynamic SQL is how a banned statement would slip past this text check (docs/security.md, D10; WP-86).
  { name: 'dynamic sql', pattern: /\bsql\.raw\s*\(|\.unsafe\s*\(/ },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx|mts|js|mjs|sql)$/.test(entry.name) ? [path] : [];
  });
}

/** Banned statements in files under root/src, root/test and root/playground, outside src/db/, test/db/ (the superuser test setup) and test/fixtures/. */
function scan(root: string): { file: string; rule: string }[] {
  const files = ['src', 'test', 'playground'].flatMap((top) => {
    try {
      return sourceFiles(join(root, top));
    } catch {
      return [];
    }
  });
  return files
    .map((file) => relative(root, file).split(sep).join('/'))
    .filter((file) => !file.startsWith('src/db/') && !file.startsWith('test/db/') && !file.startsWith('test/fixtures/'))
    .flatMap((file) => {
      const text = readFileSync(join(root, file), 'utf8');
      return BANNED.filter((b) => b.pattern.test(text)).map((b) => ({ file, rule: b.name }));
    });
}

describe('raw SQL guard', () => {
  it('flags every seeded statement and nothing else', () => {
    const found = scan(join(repoRoot, 'test/fixtures/raw-sql'))
      .map((v) => `${v.file}: ${v.rule}`)
      .sort();
    expect(found).toEqual([
      'src/modules/x/create-temp.ts: create temp',
      'src/modules/x/discard.ts: discard',
      'src/modules/x/dynamic.ts: dynamic sql',
      'src/modules/x/reset.ts: dynamic sql',
      'src/modules/x/reset.ts: reset',
      'src/modules/x/set-app.ts: set app.*',
      'src/modules/x/set-config.ts: set_config',
      'src/modules/x/set-local.ts: set role/local/session',
      'src/modules/x/set-role.ts: set role/local/session',
      'src/modules/x/set-session.ts: set role/local/session',
    ]);
  });

  it('passes on the real source tree', () => {
    expect(scan(repoRoot)).toEqual([]);
  });
});
