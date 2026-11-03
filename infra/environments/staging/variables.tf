# No real values are committed. Copy terraform.tfvars.example to terraform.tfvars (git-ignored).

variable "project_id" {
  description = "The GCP project for this environment."
  type        = string
}
variable "region" {
  type    = string
  default = "me-west1"
}
variable "public_base_url" {
  description = "HTTPS base URL of the web service, for example its run.app URL after the first apply."
  type        = string
}
variable "business_number" {
  description = "Postly's WhatsApp number for this environment."
  type        = string
}
variable "github_repository" {
  description = "owner/name of the repository whose deploy workflow may deploy here."
  type        = string
}
variable "alert_email" {
  type    = string
  default = null
}
