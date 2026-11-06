# The model per environment (docs/agent.md, Running on dev; docs/deployment.md, "Real Gemini and the
# agents on dev"). Every deployed environment runs on Gemini through Vertex AI and every agent flow,
# with no switch: the app picks the model from POSTLY_ENV. Kept apart from main.tf: main.tf only merges
# local.model_env into the web and worker environment.
#
# The Vertex AI API (apis.tf) and roles/aiplatform.user for the web and worker accounts only
# (modules/service_accounts) are already in place; nothing here grants more.

variable "vertex_location" {
  description = "The Vertex AI endpoint's location for Gemini (VERTEX_LOCATION). Vertex serves no Gemini from me-west1, and Gemini 3.5 Flash-Lite only on global and the eu/us multi-regions; eu keeps processing in the EU."
  type        = string
  default     = "eu"
  validation {
    condition     = can(regex("^(global|eu|us|[a-z]+-[a-z]+[0-9]+)$", var.vertex_location))
    error_message = "vertex_location must be global, eu, us or a region such as europe-west4."
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
  model_env    = { VERTEX_PROJECT = var.project_id, VERTEX_LOCATION = var.vertex_location }
  model_budget = var.billing_account != null
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
