# No real values are committed. Copy terraform.tfvars.example to terraform.tfvars (git-ignored).
# Only project_id, business_number and alert_email need a value; the rest have defaults.

variable "project_id" {
  description = "The GCP project for this environment."
  type        = string
}
variable "business_number" {
  description = "Postly's WhatsApp number for this environment (any made-up number on the simulators; a test number after WP-41)."
  type        = string
  validation {
    condition     = can(regex("^\\+[1-9][0-9]{6,14}$", var.business_number))
    error_message = "business_number must be an E.164 number such as +15550000001 (a made-up one is fine on the simulators)."
  }
}
variable "alert_email" {
  type    = string
  default = null
}
variable "sandbox_invokers" {
  description = "Who may open the dev sandbox through gcloud run services proxy, and by default in a browser and the console, for example [\"user:you@gmail.com\"]."
  type        = list(string)
  default     = []
}
variable "cloud_run_iap" {
  description = "Google sign-in in a browser for the console and the sandbox, through Cloud Run's built-in IAP (docs/deployment.md, \"Browser sign-in on dev\")."
  type        = bool
  default     = true
}
variable "sandbox_members" {
  description = "Who may open the sandbox in a browser; null uses sandbox_invokers."
  type        = list(string)
  default     = null
}
variable "console_members" {
  description = "Who may sign in to the console; null uses sandbox_invokers."
  type        = list(string)
  default     = null
}
variable "region" {
  type    = string
  default = "me-west1"
}
variable "public_base_url" {
  description = "HTTPS base URL of the web service; null uses its run.app URL."
  type        = string
  default     = null
  validation {
    # A placeholder such as https://REPLACE_WITH_WEB_HOST fails later as an uptime check "malformed host".
    condition     = var.public_base_url == null || can(regex("^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+/?$", var.public_base_url))
    error_message = "public_base_url must be https://<lowercase host> with no path, or left out to use the run.app URL."
  }
}
variable "github_repository" {
  description = "owner/name of the repository whose deploy workflow may deploy here."
  type        = string
  default     = "ShmuelRob/postly"
}

variable "app_metric_alerts" {
  description = "Set to true after the first deploy, once the app has written its postly.* metrics, then apply again."
  type        = bool
  default     = false
}
variable "vertex_location" {
  description = "The Vertex AI location for Gemini: the EU multi-region (Gemini 3.5 Flash-Lite is served neither from me-west1 nor from single regions)."
  type        = string
  default     = "eu"
}
variable "billing_account" {
  description = "The billing account id for the monthly Vertex AI budget alert; null creates none."
  type        = string
  default     = null
}
variable "model_budget_usd" {
  description = "The monthly Vertex AI budget on dev, in USD: twice the stack's 25 default, as the owner approved."
  type        = number
  default     = 50
}
