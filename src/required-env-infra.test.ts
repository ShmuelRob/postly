import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLOUD_PROCESSES, requiredCloudEnv, type CloudEnv } from './config.js';

// Deploy pre-flight, static half (docs/deployment.md, "Environment variables: checked before a
// deploy"): every variable a process requires in a cloud environment is set by Terraform for that
// service in that environment. A code change that needs a new variable lands with the Terraform
// that sets it. Deploy checks the live services the same way before the migration job.

const read = (path: string) => readFileSync(new URL(`../infra/${path}`, import.meta.url), 'utf8');
const stack = read('modules/stack/main.tf') + '\n' + read('modules/stack/models.tf');

/** The expression after `name =` (a local or a module argument), up to where its brackets close. */
function expression(text: string, name: string, from = 0): string {
  const match = new RegExp(String.raw`\n\s*${name}\s*=\s*`, 'g');
  match.lastIndex = from;
  const found = match.exec(text);
  if (!found) throw new Error(`no ${name} = in the Terraform`);
  let depth = 0;
  for (let i = found.index + found[0].length; i < text.length; i++) {
    const c = text[i]!;
    if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    else if (c === '\n' && depth === 0) return text.slice(found.index + found[0].length, i);
  }
  throw new Error(`unclosed ${name}`);
}

const list = (name: string) => [...expression(stack, name).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
const loginsFor = (env: CloudEnv, base: string) => [...list(base), ...(env === 'dev' ? ['app_simulator'] : [])];

/** The environment variable names a Terraform expression sets, in one environment. */
function names(expr: string, env: CloudEnv): Set<string> {
  // Only dev is simulated (local.simulated = var.env_name == "dev").
  const text = expr.replace(/local\.simulated \? (\{[^{}]*\}) : \{\}/g, (_, obj: string) => (env === 'dev' ? obj : ''));
  const out = new Set<string>([...text.matchAll(/\b([A-Z][A-Z0-9_]+)\s*=/g)].map((m) => m[1]!));
  if (/local\.login_secrets\b/.test(text)) for (const l of loginsFor(env, 'base_logins')) out.add(`DB_PASSWORD_${l.toUpperCase()}`);
  if (/local\.console_login_secrets\b/.test(text)) for (const l of loginsFor(env, 'console_base_logins')) out.add(`DB_PASSWORD_${l.toUpperCase()}`);
  for (const [, ref] of text.matchAll(/local\.([a-z_]+)/g)) {
    if (['simulated', 'login_secrets', 'console_login_secrets'].includes(ref!)) continue;
    for (const n of names(expression(stack, ref!), env)) out.add(n);
  }
  return out;
}

/** What Terraform sets for one service (or the migrate job) in one environment: its env and secret_env. */
function terraformEnv(module: string, env: CloudEnv): Set<string> {
  const start = stack.indexOf(`module "${module}" {`);
  if (start < 0) throw new Error(`no module "${module}" in the stack`);
  return new Set([...names(expression(stack, 'env', start), env), ...names(expression(stack, 'secret_env', start), env)]);
}

const ENVS: CloudEnv[] = ['dev', 'stage', 'prod'];
const MODULE: Record<(typeof CLOUD_PROCESSES)[number], string> = { web: 'web', worker: 'worker', console: 'console', migrate: 'migrate', sandbox: 'sandbox' };

describe('Terraform sets every variable the code requires (deploy pre-flight)', () => {
  it('each environment root calls the stack with its own env_name', () => {
    for (const env of ENVS) expect(read(`environments/${env}/main.tf`)).toMatch(new RegExp(`env_name\\s*=\\s*"${env}"`));
  });

  for (const env of ENVS) {
    for (const process of CLOUD_PROCESSES) {
      if (process === 'sandbox' && env !== 'dev') continue;
      it(`${process} in ${env}`, () => {
        const set = terraformEnv(MODULE[process], env);
        const missing = requiredCloudEnv(process, env).filter((name) => !set.has(name));
        expect(missing, `Terraform does not set these for ${process} in ${env}`).toEqual([]);
      });
    }
  }

  it('the derivation sees a gap: a name Terraform never sets is reported', () => {
    expect(terraformEnv('worker', 'dev').has('VERTEX_PROJECT')).toBe(true);
    expect(terraformEnv('worker', 'stage').has('SIMULATOR_STORE')).toBe(false);
    expect(terraformEnv('console', 'prod').has('DB_PASSWORD_APP_CONTENT')).toBe(false);
    expect(terraformEnv('migrate', 'prod').has('MESSAGING_WEBHOOK_SECRET')).toBe(false);
  });
});

describe('requiredCloudEnv', () => {
  it('names what loadConfig refuses to start without, and never a value', () => {
    expect(requiredCloudEnv('worker', 'dev')).toEqual(expect.arrayContaining(['POSTLY_ENV', 'VERTEX_PROJECT', 'MESSAGING_WEBHOOK_SECRET', 'SIMULATOR_STORE', 'DB_PASSWORD_APP_SIMULATOR']));
    expect(requiredCloudEnv('worker', 'prod')).not.toContain('SIMULATOR_STORE');
    expect(requiredCloudEnv('console', 'prod')).not.toContain('DB_PASSWORD_APP_CONTENT');
    expect(requiredCloudEnv('migrate', 'prod')).toEqual(expect.arrayContaining(['MIGRATE_ADMIN_URL', 'DB_PASSWORD_APP_CONTENT']));
    expect(requiredCloudEnv('sandbox', 'dev')).toContain('SANDBOX_OWNER_PHONE');
    for (const name of requiredCloudEnv('web', 'dev')) expect(name).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });
});
