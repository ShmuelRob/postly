import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// docs/security.md, "Sandbox exposure" and docs/deployment.md, "The sandbox": the dev sandbox is never
// public, exists only in dev, keeps the proxy path, and with sandbox_iap_client_id opens in a browser
// through Cloud Run's built-in IAP for the sandbox_invokers only.

const read = (path: string) => readFileSync(new URL(`../infra/${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const stack = read('modules/stack/main.tf');
const cloudRun = read('modules/cloud_run/main.tf');

/** The text of one top-level `resource "<type>" "<name>" {` (or module/data) block. */
const block = (header: string) => {
  const start = stack.indexOf(header);
  if (start < 0) throw new Error(`no ${header} in main.tf`);
  const end = stack.indexOf('\n}\n', start);
  return stack.slice(start, end + 2);
};

describe('the sandbox is never public', () => {
  it('sandbox_invokers refuses allUsers and allAuthenticatedUsers', () => {
    expect(block('variable "sandbox_invokers"')).toMatch(/!contains\(\["allUsers", "allAuthenticatedUsers"\], m\)/);
  });

  it('only dev may enable it, and only dev sets it or its IAP client', () => {
    expect(block('variable "sandbox_enabled"')).toContain('!var.sandbox_enabled || var.env_name == "dev"');
    expect(block('variable "sandbox_iap_client_id"')).toContain('var.sandbox_iap_client_id == null || var.sandbox_enabled');
    for (const env of ['stage', 'prod']) expect(read(`environments/${env}/main.tf`)).not.toMatch(/sandbox_/);
    expect(read('environments/dev/main.tf')).toMatch(/sandbox_enabled\s*=\s*true/);
  });

  it('no sandbox grant names allUsers or allAuthenticatedUsers', () => {
    const grants = [
      block('resource "google_cloud_run_v2_service_iam_member" "sandbox"'),
      block('resource "google_iap_web_cloud_run_service_iam_member" "sandbox"'),
      block('resource "google_cloud_run_v2_service_iam_member" "sandbox_iap_invoker"'),
    ];
    for (const g of grants) expect(g).not.toMatch(/allUsers|allAuthenticatedUsers/);
    expect(block('module "sandbox"')).toMatch(/public\s*=\s*false/);
  });
});

describe('the proxy path stays', () => {
  it('sandbox_invokers keep run.invoker whether or not IAP is on', () => {
    const g = block('resource "google_cloud_run_v2_service_iam_member" "sandbox"');
    expect(g).toContain('for_each = var.sandbox_enabled ? toset(var.sandbox_invokers) : toset([])');
    expect(g).toContain('"roles/run.invoker"');
  });

  it("gcloud's OAuth client is an IAP programmatic client, so the proxy's token passes IAP", () => {
    expect(stack).toContain('gcloud_oauth_client = "32555940559.apps.googleusercontent.com"');
    expect(block('resource "google_iap_settings" "sandbox"')).toContain('programmatic_clients = [local.gcloud_oauth_client]');
  });
});

describe('the browser path: Cloud Run built-in IAP', () => {
  it('is on only with sandbox_iap_client_id, and turns on iap_enabled on the sandbox service', () => {
    expect(stack).toContain('sandbox_iap = var.sandbox_enabled && var.sandbox_iap_client_id != null');
    expect(block('module "sandbox"')).toMatch(/iap_enabled\s*=\s*local\.sandbox_iap/);
    expect(cloudRun).toMatch(/iap_enabled\s*=\s*var\.iap_enabled/);
    expect(cloudRun).toMatch(/variable "iap_enabled" \{[^}]*default\s*=\s*false/);
  });

  it('only sandbox_invokers get IAP access, on the sandbox service only', () => {
    const g = block('resource "google_iap_web_cloud_run_service_iam_member" "sandbox"');
    expect(g).toContain('for_each               = local.sandbox_iap ? toset(var.sandbox_invokers) : toset([])');
    expect(g).toContain('cloud_run_service_name = module.sandbox[0].name');
    expect(g).toContain('"roles/iap.httpsResourceAccessor"');
  });

  it("IAP's service agent may invoke the sandbox", () => {
    const g = block('resource "google_cloud_run_v2_service_iam_member" "sandbox_iap_invoker"');
    expect(g).toContain('count      = local.sandbox_iap ? 1 : 0');
    expect(g).toContain('"roles/run.invoker"');
    expect(g).toContain('serviceAccount:service-${data.google_project.this.number}@gcp-sa-iap.iam.gserviceaccount.com');
  });

  it("IAP uses the project's own OAuth client on the sandbox service", () => {
    const s = block('resource "google_iap_settings" "sandbox"');
    expect(s).toContain('iap_web/cloud_run-${var.region}/services/${module.sandbox[0].name}');
    expect(s).toContain('client_id            = var.sandbox_iap_client_id');
  });

  it('payment links point at the run.app URL with IAP, at the proxy without', () => {
    expect(stack).toContain(
      'sandbox_url = coalesce(var.sandbox_url, local.sandbox_iap ? "https://${local.prefix}-sandbox-${data.google_project.this.number}.${var.region}.run.app" : "http://localhost:8081")',
    );
    expect(stack).toMatch(/SANDBOX_URL\s*=\s*local\.sandbox_url/);
  });
});
