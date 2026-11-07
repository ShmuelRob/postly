# No real values are committed. Copy terraform.tfvars.example to terraform.tfvars (git-ignored).
# Only project_id, business_number, alert_email and image_registry_project need a value; the rest have defaults.

variable "project_id" {
  description = "The GCP project for this environment."
  type        = string
}
variable "image_registry_project" {
  description = "Dev's project, which holds the shared image repository `postly` (the dev root's image_registry output)."
  type        = string
}
variable "image_registry_location" {
  description = "The shared image repository's location; null is this environment's region (me-west1 everywhere today)."
  type        = string
  default     = null
}
variable "business_number" {
  description = "Postly's WhatsApp number for this environment (a test number)."
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
variable "deploy_reviewers" {
  description = "GitHub usernames that must approve a deploy to this environment."
  type        = list(string)
  default     = ["ShmuelRob"]
}
variable "console_iap_client_id" {
  description = "The OAuth client id made by hand for IAP; null creates no console load balancer (docs/deployment.md)."
  type        = string
  default     = null
}
variable "console_domain" {
  description = "The console's domain: a real domain (stage and prod must not use sslip.io)."
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
