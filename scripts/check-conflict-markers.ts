// Fails when a tracked file still holds a git conflict marker, so a bad conflict merge can't land.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const MARKER = /^(<{7}|={7}|>{7})(\s|$)/;

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && existsSync(f) && !/\.(png|jpe?g|webp|gif|ico|woff2?|ttf|lock)$/i.test(f));

const hits: string[] = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (text.includes('\u0000')) continue;
  text.split('\n').forEach((line, i) => {
    if (MARKER.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

if (hits.length > 0) {
  console.error(`Conflict markers found:\n${hits.join('\n')}`);
  process.exit(1);
}
console.log(`No conflict markers in ${files.length} files.`);
