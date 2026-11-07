import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `npm run test:pg`: starts or reuses the one shared local test Postgres (technical-design.md, "Local
// test database"). With arguments, it then runs `vitest run <arguments>` against it, each run in a
// database of its own: `npm run test:pg -- --project db src/db/least-privilege.db.test.ts`.
// Local only; CI keeps one Testcontainers Postgres per job.

export const CONTAINER = 'postly-test-pg';
export const IMAGE = 'postgres:17-alpine';
export const PORT = 55432;
/** A test-only password for a container bound to 127.0.0.1. */
export const PASSWORD = 'test-only';
export const SERVER_URL = `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
/** Its share of the machine, so several sessions' runs cannot take all of it. */
export const LIMITS = { cpus: '2', memory: '2g' };

/** `docker run` arguments for the container: the limits, a local-only port, and settings for throwaway data. */
export function dockerRunArgs(): string[] {
  return [
    'run',
    '--detach',
    '--name',
    CONTAINER,
    '--cpus',
    LIMITS.cpus,
    '--memory',
    LIMITS.memory,
    '--publish',
    `127.0.0.1:${PORT}:5432`,
    '--env',
    `POSTGRES_PASSWORD=${PASSWORD}`,
    IMAGE,
    // Several sessions' runs at once, each with a pool per role login.
    '-c',
    'max_connections=500',
    // Test data is thrown away: no need to survive a crash.
    '-c',
    'fsync=off',
    '-c',
    'synchronous_commit=off',
    '-c',
    'full_page_writes=off',
  ];
}

function docker(args: string[]) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}

/** Starts the container if it is missing or stopped, then waits until Postgres accepts TCP connections. */
export function ensureServer(): void {
  const state = docker(['inspect', '--format', '{{.State.Running}}', CONTAINER]);
  if (state.status !== 0) {
    const run = docker(dockerRunArgs());
    // Another session may have created it a moment ago.
    if (run.status !== 0 && !/already in use/i.test(run.stderr)) throw new Error(`docker run failed: ${run.stderr.trim()}`);
  } else if (state.stdout.trim() !== 'true') {
    const start = docker(['start', CONTAINER]);
    if (start.status !== 0) throw new Error(`docker start failed: ${start.stderr.trim()}`);
  }
  const deadline = Date.now() + 60_000;
  // -h 127.0.0.1: the image's first-start init server listens only on the socket, so this waits for the real one.
  while (docker(['exec', CONTAINER, 'pg_isready', '-q', '-h', '127.0.0.1', '-U', 'postgres']).status !== 0) {
    if (Date.now() > deadline) throw new Error(`${CONTAINER} did not become ready within 60 s`);
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 500)']);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  ensureServer();
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(`${CONTAINER} is running (${LIMITS.cpus} CPUs, ${LIMITS.memory}).\nTEST_PG_SERVER_URL=${SERVER_URL}`);
    console.log('Run tests on it: npm run test:pg -- <vitest arguments>');
  } else {
    const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [vitest, 'run', ...args], { stdio: 'inherit', env: { ...process.env, TEST_PG_SERVER_URL: SERVER_URL } });
    process.exit(result.status ?? 1);
  }
}
