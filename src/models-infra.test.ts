import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The model per environment (agent.md, Running on dev; docs/deployment.md, "Real Gemini and the agents
// on dev"): Terraform sets what src/config.ts reads, Vertex AI everywhere with no switch and no agent
// flow switch, and Vertex AI access for web and worker only.

const read = (path: string) => readFileSync(new URL(`../infra/${path}`, import.meta.url), 'utf8');
const models = read('modules/stack/models.tf');

describe('the model in Terraform', () => {
  it('sets VERTEX_PROJECT and VERTEX_LOCATION for web and worker in every environment, with no switch', () => {
    expect(models).toMatch(/model_env\s*=\s*\{\s*VERTEX_PROJECT\s*=\s*var\.project_id,\s*VERTEX_LOCATION\s*=\s*var\.vertex_location\s*\}/);
    expect(read('modules/stack/main.tf')).toMatch(/app_env = merge\([\s\S]*?local\.model_env\)/);
  });

  it('has no models or agent_flows variable, and sets no POSTLY_MODELS or POSTLY_AGENT_FLOWS, anywhere', () => {
    const files = ['modules/stack/models.tf', 'modules/stack/main.tf', 'environments/dev/main.tf', 'environments/dev/variables.tf', 'environments/dev/terraform.tfvars.example'];
    for (const env of ['stage', 'prod']) files.push(`environments/${env}/main.tf`);
    for (const file of files) {
      const text = read(file);
      expect(text, file).not.toMatch(/variable "(models|agent_flows)"/);
      expect(text, file).not.toMatch(/^\s*(models|agent_flows)\s*=/m);
      expect(text, file).not.toMatch(/POSTLY_MODELS|POSTLY_AGENT_FLOWS/);
    }
  });

  it('defaults the location to the EU multi-region (Gemini 3.5 Flash-Lite is served only on global, eu and us)', () => {
    expect(models).toMatch(/variable "vertex_location"[\s\S]*?default\s*=\s*"eu"/);
    expect(read('environments/dev/variables.tf')).toMatch(/variable "vertex_location"[\s\S]*?default\s*=\s*"eu"/);
  });

  it('grants Vertex AI to the web and worker accounts only', () => {
    const accounts = read('modules/service_accounts/main.tf');
    expect(accounts).toMatch(/for account in \["web", "worker"\] : "\$\{account\}-roles\/aiplatform\.user"/);
    expect(accounts.match(/aiplatform/g)).toHaveLength(2);
    expect(models).not.toMatch(/resource "google_[a-z_]*iam/);
  });

  it('adds a monthly Vertex AI budget only with a billing account', () => {
    expect(models).toMatch(/model_budget\s*=\s*var\.billing_account != null/);
    expect(models).toMatch(/resource "google_billing_budget" "model" \{\s*count\s*=\s*local\.model_budget \? 1 : 0/);
    expect(read('environments/dev/variables.tf')).toMatch(/variable "model_budget_usd"[\s\S]*?default\s*=\s*50/);
  });
});
