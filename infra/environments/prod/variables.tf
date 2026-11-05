# No real values are committed. Copy terraform.tfvars.example to terraform.tfvars (git-ignored).
# Only project_id, business_number and alert_email need a value; the rest have defaults.

variable "project_id" {
  description = "The GCP project for this environment."
  type        = string
}
variable "business_number" {
  description = "Postly's WhatsApp number for this environment (the real number)."
  type        = string
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
