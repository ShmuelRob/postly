# The console's way in (docs/security.md, "Console exposure"; WP-82): a global external Application
# Load Balancer with a Google-managed certificate, IAP on the backend service, and a serverless NEG
# to the console Cloud Run service. Team members sign in with their Google accounts; only the
# accounts in `members` pass IAP. HTTPS only: there is no port 80 rule.
#
# The OAuth brand (consent screen, External) and the OAuth client are a one-time manual step per
# project (docs/deployment.md, "Console sign-in: one-time steps"): Google's IAP OAuth Admin API is
# deprecated and only ever made Internal brands. Not applied by any agent (gate H8).

terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.20, < 8.0"
    }
  }
}

variable "project_id" { type = string }
variable "project_number" { type = string }
variable "region" { type = string }
variable "prefix" { type = string }
variable "service_name" {
  description = "The console Cloud Run service. A name, not a reference, so the service can read this module's audience without a cycle."
  type        = string
}
variable "domain" {
  description = "The console's domain, for the managed certificate. Null uses <ip with dashes>.sslip.io (dev only, see docs/security.md)."
  type        = string
  default     = null
}
variable "members" {
  description = "IAP access list: user:<email>, group:<email> or domain:<domain>. Empty lets nobody in."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for m in var.members : can(regex("^(user|group|domain):[^ ]+$", m))])
    error_message = "Each member must be user:<email>, group:<email> or domain:<domain>."
  }
}
variable "oauth_client_id" {
  description = "The OAuth client (Web application) made by hand for IAP."
  type        = string
}
variable "oauth_client_secret_id" {
  description = "The Secret Manager secret holding that client's secret (its value is added by the human)."
  type        = string
}

locals {
  domain = coalesce(var.domain, "${replace(google_compute_global_address.console.address, ".", "-")}.sslip.io")
}

data "google_secret_manager_secret_version" "oauth_client_secret" {
  project = var.project_id
  secret  = var.oauth_client_secret_id
}

resource "google_compute_global_address" "console" {
  project = var.project_id
  name    = "${var.prefix}-console"
}

resource "google_compute_region_network_endpoint_group" "console" {
  project               = var.project_id
  name                  = "${var.prefix}-console"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = var.service_name
  }
}

resource "google_compute_backend_service" "console" {
  project               = var.project_id
  name                  = "${var.prefix}-console"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  backend {
    group = google_compute_region_network_endpoint_group.console.id
  }
  iap {
    enabled              = true
    oauth2_client_id     = var.oauth_client_id
    oauth2_client_secret = data.google_secret_manager_secret_version.oauth_client_secret.secret_data
  }
  log_config {
    enable      = true
    sample_rate = 1
  }
}

resource "google_compute_url_map" "console" {
  project         = var.project_id
  name            = "${var.prefix}-console"
  default_service = google_compute_backend_service.console.id
}

resource "google_compute_managed_ssl_certificate" "console" {
  project = var.project_id
  # The name carries the domain's hash: a new domain needs a new certificate before the old one goes.
  name = "${var.prefix}-console-${substr(sha256(local.domain), 0, 8)}"
  managed {
    domains = [local.domain]
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "google_compute_ssl_policy" "console" {
  project         = var.project_id
  name            = "${var.prefix}-console"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

resource "google_compute_target_https_proxy" "console" {
  project          = var.project_id
  name             = "${var.prefix}-console"
  url_map          = google_compute_url_map.console.id
  ssl_certificates = [google_compute_managed_ssl_certificate.console.id]
  ssl_policy       = google_compute_ssl_policy.console.id
}

resource "google_compute_global_forwarding_rule" "console" {
  project               = var.project_id
  name                  = "${var.prefix}-console"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.console.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.console.id
}

# Only the listed team accounts pass IAP, and only for this backend.
resource "google_iap_web_backend_service_iam_member" "member" {
  for_each            = toset(var.members)
  project             = var.project_id
  web_backend_service = google_compute_backend_service.console.name
  role                = "roles/iap.httpsResourceAccessor"
  member              = each.value
}

# IAP calls the console as this service agent; the stack grants it run.invoker on the console
# service (there, because the service reads this module's audience).
output "iap_service_agent" { value = "service-${var.project_number}@gcp-sa-iap.iam.gserviceaccount.com" }
output "ip" { value = google_compute_global_address.console.address }
output "domain" { value = local.domain }
output "url" { value = "https://${local.domain}/console" }
# What the console checks as the `aud` of IAP's signed header (CONSOLE_IAP_AUDIENCE).
output "audience" { value = "/projects/${var.project_number}/global/backendServices/${google_compute_backend_service.console.generated_id}" }
