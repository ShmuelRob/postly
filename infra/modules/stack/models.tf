# The model and the agent flows per environment (docs/agent.md, Running on dev; docs/deployment.md,
# "Real Gemini and the agent flows on dev"). Kept apart from main.tf: main.tf only merges local.model_env
# into the web and worker environment.
#
# The Vertex AI API (apis.tf) and roles/aiplatform.user for the web and worker accounts only
# (modules/service_accounts) are already in place; nothing here grants more.

variable "models" {
  description = "The model provider: \"simulator\" (the word-rule model) or \"vertex\" (Gemini through Vertex AI; the other providers stay simulated). Sets POSTLY_MODELS."
  type        = string
  default     = "simulator"
  validation {
    condition     = contains(["simulator", "vertex"], var.models)
    error_message = "models must be \"simulator\" or \"vertex\"."
  }
}

variable "vertex_location" {
  description = "The Vertex AI endpoint's location for Gemini (VERTEX_LOCATION). Vertex serves no Gemini from me-west1, and Gemini 3.5 Flash-Lite only on global and the eu/us multi-regions; eu keeps processing in the EU."
  type        = string
  default     = "eu"
  validation {
    condition     = can(regex("^(global|eu|us|[a-z]+-[a-z]+[0-9]+)$", var.vertex_location))
    error_message = "vertex_location must be global, eu, us or a region such as europe-west4."
  }
}

variable "agent_flows" {
  description = "The flows that run on the agent for every business (POSTLY_AGENT_FLOWS, written into system_control.agent_flows at web startup): any of onboarding, weekly, drafts, or [\"none\"]. Empty leaves the switch as it is (off by default)."
  type        = list(string)
  default     = []
  validation {
    condition = (
      alltrue([for f in var.agent_flows : contains(["onboarding", "weekly", "drafts"], f)])
      || var.agent_flows == ["none"]
    )
    error_message = "agent_flows lists onboarding, weekly and drafts, or is [\"none\"]."
  }
}

variable "billing_account" {
  description = "The billing account id (XXXXXX-XXXXXX-XXXXXX) for the monthly Vertex AI budget; null creates no budget."
  type        = string
  default     = null
}

variable "model_budget_usd" {
  description = "The monthly Vertex AI budget in USD (a warning by email at 50%, 90% and 100%; it never stops spending)."
  type        = number
  default     = 25
  validation {
    condition     = var.model_budget_usd > 0
    error_message = "model_budget_usd must be positive."
  }
}

variable "vertex_billing_service" {
  description = "The Cloud Billing service id of Vertex AI, which the budget filters on (Billing > Pricing lists it)."
  type        = string
  default     = "C7E2-9256-1C43"
}

locals {
  model_env = merge(
    { POSTLY_MODELS = var.models },
    var.models == "vertex" ? { VERTEX_PROJECT = var.project_id, VERTEX_LOCATION = var.vertex_location } : {},
    length(var.agent_flows) > 0 ? { POSTLY_AGENT_FLOWS = join(",", var.agent_flows) } : {},
  )
  model_budget = var.models == "vertex" && var.billing_account != null
}

resource "google_project_service" "billing_budgets" {
  count              = local.model_budget ? 1 : 0
  project            = var.project_id
  service            = "billingbudgets.googleapis.com"
  disable_on_destroy = false
}

# A warning, not a cap: the agent's daily limits (docs/agent.md, Limits) are what stop the spend.
resource "google_billing_budget" "model" {
  count           = local.model_budget ? 1 : 0
  depends_on      = [google_project_service.billing_budgets]
  billing_account = var.billing_account
  display_name    = "Postly ${var.env_name}: Vertex AI (Gemini) monthly"

  budget_filter {
    projects        = ["projects/${data.google_project.this.number}"]
    services        = ["services/${var.vertex_billing_service}"]
    calendar_period = "MONTH"
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.model_budget_usd)
    }
  }

  threshold_rules { threshold_percent = 0.5 }
  threshold_rules { threshold_percent = 0.9 }
  threshold_rules { threshold_percent = 1.0 }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    monitoring_notification_channels = module.monitoring.email_channel_ids
    # The billing account's admins get the emails too, so a budget without alert_email still reaches someone.
    disable_default_iam_recipients = false
  }
}
