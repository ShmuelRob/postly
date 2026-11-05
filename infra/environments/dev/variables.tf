# No real values are committed. Copy terraform.tfvars.example to terraform.tfvars (git-ignored).
# Only project_id, business_number and alert_email need a value; the rest have defaults.

variable "project_id" {
  description = "The GCP project for this environment."
  type        = string
}
variable "business_number" {
  description = "Postly's WhatsApp number for this environment (any made-up number on the simulators; a test number after WP-41)."
  type        = string
}
variable "alert_email" {
  type    = string
  default = null
}
variable "sandbox_invokers" {
  description = "Who may open the dev sandbox (in a browser with sandbox_iap_client_id, or through gcloud run services proxy), for example [\"user:you@example.com\"]."
  type        = list(string)
  default     = []
}
variable "sandbox_iap_client_id" {
  description = "The OAuth client id made by hand (the console's works); set, the sandbox opens at sandbox_url in a browser through IAP (docs/deployment.md)."
  type        = string
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
variable "console_iap_client_id" {
  description = "The OAuth client id made by hand for IAP; null creates no console load balancer (docs/deployment.md)."
  type        = string
  default     = null
}
variable "console_domain" {
  description = "The console's domain; null uses <ip>.sslip.io, which is for dev only (docs/security.md)."
  type        = string
  default     = null
}
variable "console_members" {
  description = "Who may sign in to the console, e.g. [\"user:you@gmail.com\"]. Empty by default: nobody."
  type        = list(string)
  default     = []
}

variable "app_metric_alerts" {
  description = "Set to true after the first deploy, once the app has written its postly.* metrics, then apply again."
  type        = bool
  default     = false
}
