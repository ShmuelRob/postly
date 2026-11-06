import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Drizzle's migrator applies only migrations whose journal `when` is later than the last applied one,
// so a new entry with an earlier timestamp (drizzle-kit stamps the local clock) is skipped silently on
// a database that already ran the previous migration.
const dir = new URL('../../drizzle/', import.meta.url);
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', dir), 'utf8')) as {
  entries: { idx: number; when: number; tag: string }[];
};

describe('the migration journal', () => {
  it('numbers the entries in order and stamps each later than the one before', () => {
    journal.entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
      expect(entry.tag.startsWith(String(i).padStart(4, '0') + '_')).toBe(true);
      if (i > 0) expect(entry.when, entry.tag).toBeGreaterThan(journal.entries[i - 1]!.when);
    });
  });

  it('has exactly one SQL file per entry', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    expect(files).toEqual(journal.entries.map((e) => `${e.tag}.sql`));
  });
});
