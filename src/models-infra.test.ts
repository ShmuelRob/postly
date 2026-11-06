import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAgentFlows } from './agent-flows.js';

// The model and the agent flows per environment (agent.md, Running on dev; docs/deployment.md, "Real
// Gemini and the agent flows on dev"): Terraform must set what src/config.ts reads, real Gemini and
// the flows only where dev's tfvars ask for them, and Vertex AI access for web and worker only.

const read = (path: string) => readFileSync(new URL(`../infra/${path}`, import.meta.url), 'utf8');
const models = read('modules/stack/models.tf');

describe('models and agent flows in Terraform', () => {
  it('sets POSTLY_MODELS, VERTEX_* with vertex, and POSTLY_AGENT_FLOWS when flows are listed, for web and worker', () => {
    expect(models).toMatch(/POSTLY_MODELS\s*=\s*var\.models/);
    expect(models).toMatch(/VERTEX_PROJECT\s*=\s*var\.project_id,\s*VERTEX_LOCATION\s*=\s*var\.vertex_location/);
    expect(models).toMatch(/POSTLY_AGENT_FLOWS\s*=\s*join\(",", var\.agent_flows\)/);
    expect(read('modules/stack/main.tf')).toMatch(/app_env = merge\([\s\S]*?local\.model_env\)/);
  });

  it('defaults to the model simulator with no flows; only dev passes the variables', () => {
    expect(models).toMatch(/variable "models"[\s\S]*?default\s*=\s*"simulator"/);
    expect(models).toMatch(/variable "agent_flows"[\s\S]*?default\s*=\s*\[\]/);
    for (const env of ['stage', 'prod']) expect(read(`environments/${env}/main.tf`)).not.toMatch(/\b(models|agent_flows)\s*=/);
    expect(read('environments/dev/main.tf')).toMatch(/agent_flows\s*=\s*var\.agent_flows/);
  });

  it("dev's example turns on real Gemini and all three flows, in a form the app accepts", () => {
    const example = read('environments/dev/terraform.tfvars.example');
    expect(example).toMatch(/^models\s*=\s*"vertex"$/m);
    const flows = example.match(/^agent_flows\s*=\s*\[(.*)\]$/m)?.[1];
    expect(flows).toBeDefined();
    const names = [...flows!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(parseAgentFlows(names.join(','))).toEqual({ onboarding: true, weekly: true, drafts: true });
  });

  it('grants Vertex AI to the web and worker accounts only', () => {
    const accounts = read('modules/service_accounts/main.tf');
    expect(accounts).toMatch(/for account in \["web", "worker"\] : "\$\{account\}-roles\/aiplatform\.user"/);
    expect(accounts.match(/aiplatform/g)).toHaveLength(2);
    expect(models).not.toMatch(/resource "google_[a-z_]*iam/);
  });

  it('adds a monthly Vertex AI budget only with real Gemini and a billing account', () => {
    expect(models).toMatch(/model_budget\s*=\s*var\.models == "vertex" && var\.billing_account != null/);
    expect(models).toMatch(/resource "google_billing_budget" "model" \{\s*count\s*=\s*local\.model_budget \? 1 : 0/);
    expect(read('environments/dev/variables.tf')).toMatch(/variable "model_budget_usd"[\s\S]*?default\s*=\s*50/);
  });
});
