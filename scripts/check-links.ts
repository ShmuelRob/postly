// Fails on a broken relative markdown link (file missing, or #anchor with no matching heading).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const slug = (h: string) =>
  h.trim().toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');

const anchors = (file: string) =>
  new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => /^#{1,6}\s/.test(l))
      .map((l) => slug(l.replace(/^#+\s*/, ''))),
  );

const files = execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && existsSync(f));

const broken: string[] = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [path = '', anchor] = target.split('#');
    const abs = path ? resolve(dirname(file), decodeURI(path)) : resolve(file);
    if (!existsSync(abs)) broken.push(`${file}: ${target} (missing file)`);
    else if (anchor && abs.endsWith('.md') && !anchors(abs).has(anchor)) broken.push(`${file}: ${target} (missing anchor)`);
  }
}
if (broken.length > 0) {
  console.error(`Broken markdown links:\n${broken.join('\n')}`);
  process.exit(1);
}
console.log(`Checked links in ${files.length} markdown files.`);
