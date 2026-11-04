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
