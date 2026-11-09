import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IAP_AUDIENCE_PATTERN } from './modules/console/index.js';

// docs/security.md, "Sandbox exposure" and "Console exposure", and docs/deployment.md, "Browser sign-in
// on dev": the dev sandbox exists only in dev and is public only through dev's sandbox_public switch
// (off by default; every IAP setting stays in place, so turning it off restores sign-in); with cloud_run_iap (dev's default)
// the sandbox and the console open in a browser through Cloud Run's built-in IAP, each for its own
// member list only, with no load balancer and no OAuth secret in Terraform. Stage and prod keep the
// console's load balancer.

const read = (path: string) => readFileSync(new URL(`../infra/${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const stack = read('modules/stack/main.tf');
const cloudRun = read('modules/cloud_run/main.tf');
const dev = read('environments/dev/main.tf');
const devVariables = read('environments/dev/variables.tf');

/** The text of one top-level `resource "<type>" "<name>" {` (or module/data/variable) block. */
const block = (header: string, text = stack) => {
  const start = text.indexOf(header);
  if (start < 0) throw new Error(`no ${header}`);
  const end = text.indexOf('\n}\n', start);
  return text.slice(start, end + 2);
};
const NOT_PUBLIC = /!contains\(\["allUsers", "allAuthenticatedUsers"\], m\)/;

describe('the console is never public; the sandbox only through sandbox_public', () => {
  it('sandbox_invokers, sandbox_members and console_members refuse allUsers and allAuthenticatedUsers', () => {
    expect(block('variable "sandbox_invokers"')).toMatch(NOT_PUBLIC);
    expect(block('variable "sandbox_members"')).toMatch(NOT_PUBLIC);
    expect(block('variable "console_members"')).toMatch(NOT_PUBLIC);
  });

  it('only dev may enable the sandbox or Cloud Run IAP, and only dev sets them', () => {
    expect(block('variable "sandbox_enabled"')).toContain('!var.sandbox_enabled || var.env_name == "dev"');
    expect(block('variable "cloud_run_iap"')).toContain('!var.cloud_run_iap || (var.env_name == "dev" && var.console_iap_client_id == null)');
    for (const env of ['stage', 'prod']) {
      expect(read(`environments/${env}/main.tf`)).not.toMatch(/sandbox_|cloud_run_iap/);
    }
    expect(dev).toMatch(/sandbox_enabled\s*=\s*true/);
    expect(dev).toMatch(/cloud_run_iap\s*=\s*var\.cloud_run_iap/);
  });

  it('no grant names allUsers or allAuthenticatedUsers, and neither service is public', () => {
    const grants = [
      block('resource "google_cloud_run_v2_service_iam_member" "sandbox"'),
      block('resource "google_iap_web_cloud_run_service_iam_member" "sandbox"'),
      block('resource "google_cloud_run_v2_service_iam_member" "sandbox_iap_invoker"'),
      block('resource "google_iap_web_cloud_run_service_iam_member" "console"'),
      block('resource "google_cloud_run_v2_service_iam_member" "console_iap_invoker"'),
    ];
    for (const g of grants) expect(g).not.toMatch(/allUsers|allAuthenticatedUsers/);
    expect(block('module "sandbox"')).toMatch(/public\s*=\s*var\.sandbox_public\n/);
    expect(block('module "console"')).toMatch(/public\s*=\s*false/);
  });

  it('no OAuth client secret reaches Terraform: no IAP settings resource reads one', () => {
    expect(stack).not.toMatch(/resource "google_iap_settings"/);
    expect(stack).not.toMatch(/sandbox_iap_client_id|gcloud_oauth_client/);
  });
});

describe('dev: the sandbox_public switch', () => {
  it('is off by default and allowed only in dev', () => {
    const v = block('variable "sandbox_public"');
    expect(v).toMatch(/default\s*=\s*false/);
    expect(v).toContain('!var.sandbox_public || (var.env_name == "dev" && var.sandbox_enabled)');
    expect(block('variable "sandbox_public"', devVariables)).toMatch(/default\s*=\s*false/);
    expect(dev).toMatch(/sandbox_public\s*=\s*var\.sandbox_public/);
  });

  it('turns off IAP on the sandbox service only, and keeps every IAP grant for when it is turned off', () => {
    expect(block('module "sandbox"')).toMatch(/iap_enabled\s*=\s*local\.sandbox_iap && !var\.sandbox_public/);
    expect(block('module "console"')).not.toMatch(/sandbox_public/);
    // The IAP grants, and with them the run.app SANDBOX_URL, still follow cloud_run_iap alone.
    expect(block('resource "google_iap_web_cloud_run_service_iam_member" "sandbox"')).not.toMatch(/sandbox_public/);
    expect(block('resource "google_cloud_run_v2_service_iam_member" "sandbox_iap_invoker"')).not.toMatch(/sandbox_public/);
    expect(stack).not.toMatch(/sandbox_iap\s*=.*sandbox_public/);
  });

  it("opens it through the cloud_run module's allUsers invoker, with ingress from the internet", () => {
    const pub = block('resource "google_cloud_run_v2_service_iam_member" "public"', cloudRun);
    expect(pub).toContain('count    = var.kind == "service" && var.public ? 1 : 0');
    expect(pub).toContain('member   = "allUsers"');
    expect(cloudRun).toContain(
      'ingress             = coalesce(var.ingress, var.public || var.external_ingress ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY")',
    );
  });
});

describe('the proxy path stays', () => {
  it('sandbox_invokers keep run.invoker whether or not IAP is on', () => {
    const g = block('resource "google_cloud_run_v2_service_iam_member" "sandbox"');
    expect(g).toContain('for_each = var.sandbox_enabled ? toset(var.sandbox_invokers) : toset([])');
    expect(g).toContain('"roles/run.invoker"');
  });
});

describe('dev: the sandbox in a browser through Cloud Run built-in IAP', () => {
  it('dev turns it on by default, and both member lists default to sandbox_invokers', () => {
    expect(block('variable "cloud_run_iap"', devVariables)).toMatch(/default\s*=\s*true/);
    expect(block('variable "cloud_run_iap"')).toMatch(/default\s*=\s*false/);
    expect(stack).toContain('sandbox_members = var.sandbox_members != null ? var.sandbox_members : var.sandbox_invokers');
    expect(dev).toContain('console_members = var.console_members != null ? var.console_members : var.sandbox_invokers');
  });

  it('turns on iap_enabled on the sandbox service unless sandbox_public', () => {
    expect(stack).toContain('sandbox_iap     = var.sandbox_enabled && var.cloud_run_iap');
    expect(block('module "sandbox"')).toMatch(/iap_enabled\s*=\s*local\.sandbox_iap && !var\.sandbox_public/);
    expect(cloudRun).toMatch(/iap_enabled\s*=\s*var\.iap_enabled/);
    expect(cloudRun).toMatch(/variable "iap_enabled" \{[^}]*default\s*=\s*false/);
  });

  it('only sandbox_members get IAP access, on the sandbox service only', () => {
    const g = block('resource "google_iap_web_cloud_run_service_iam_member" "sandbox"');
    expect(g).toContain('for_each               = local.sandbox_iap ? toset(local.sandbox_members) : toset([])');
    expect(g).toContain('cloud_run_service_name = module.sandbox[0].name');
    expect(g).toContain('"roles/iap.httpsResourceAccessor"');
  });

  it("IAP's service agent may invoke the sandbox", () => {
    const g = block('resource "google_cloud_run_v2_service_iam_member" "sandbox_iap_invoker"');
    expect(g).toContain('count      = local.sandbox_iap ? 1 : 0');
    expect(g).toContain('"roles/run.invoker"');
    expect(g).toContain('serviceAccount:${local.iap_service_agent}');
    expect(stack).toContain('iap_service_agent = "service-${data.google_project.this.number}@gcp-sa-iap.iam.gserviceaccount.com"');
  });

  it('payment links point at the run.app URL with IAP, at the proxy without', () => {
    expect(stack).toContain(
      'sandbox_url = coalesce(var.sandbox_url, local.sandbox_iap ? "https://${local.prefix}-sandbox-${data.google_project.this.number}.${var.region}.run.app" : "http://localhost:8081")',
    );
    expect(stack).toMatch(/SANDBOX_URL\s*=\s*local\.sandbox_url/);
  });
});

describe('dev: the console in a browser through Cloud Run built-in IAP', () => {
  it('turns on iap_enabled on the console service, with ingress from the internet only then', () => {
    const m = block('module "console"');
    expect(m).toMatch(/iap_enabled\s*=\s*var\.cloud_run_iap/);
    expect(m).toContain('ingress              = var.cloud_run_iap ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"');
  });

  it('builds no load balancer: console_ingress exists only with console_iap_client_id', () => {
    expect(stack).toContain('console_lb      = var.console_iap_client_id != null');
    expect(block('module "console_ingress"')).toContain('count                  = local.console_lb ? 1 : 0');
    expect(dev).not.toMatch(/console_iap_client_id|console_domain/);
  });

  it('only console_members get IAP access, on the console service only', () => {
    const g = block('resource "google_iap_web_cloud_run_service_iam_member" "console"');
    expect(g).toContain('for_each               = var.cloud_run_iap ? toset(var.console_members) : toset([])');
    expect(g).toContain('cloud_run_service_name = module.console.name');
    expect(g).toContain('"roles/iap.httpsResourceAccessor"');
  });

  it("only IAP's service agent may invoke the console", () => {
    const g = block('resource "google_cloud_run_v2_service_iam_member" "console_iap_invoker"');
    expect(g).toContain('count    = local.console_enabled ? 1 : 0');
    expect(g).toContain('member   = "serviceAccount:${local.iap_service_agent}"');
    expect(stack).toContain('console_enabled = local.console_lb || var.cloud_run_iap');
  });

  it('tells the console the audience Cloud Run IAP signs and its run.app host, in a form the console accepts', () => {
    const env = block('locals {\n  console_lb');
    expect(env).toContain('console_run_app_host = "${local.prefix}-console-${data.google_project.this.number}.${var.region}.run.app"');
    expect(env).toContain('CONSOLE_IAP_AUDIENCE = "/projects/${data.google_project.this.number}/locations/${var.region}/services/${local.prefix}-console"');
    expect(env).toContain('CONSOLE_HOST         = local.console_run_app_host');
    expect(env).toContain('console_env = merge(local.app_env, { CONSOLE_AUTH = "iap" }, local.console_iap_env)');
    // The same template, filled in for dev, passes the console's own check.
    expect(IAP_AUDIENCE_PATTERN.test('/projects/123456789012/locations/me-west1/services/postly-dev-console')).toBe(true);
  });

  it('outputs the console URL', () => {
    expect(stack).toContain('output "console_url" { value = var.cloud_run_iap ? "https://${local.console_run_app_host}/console"');
    expect(dev).toContain('output "console_url" { value = module.postly.console_url }');
  });
});
