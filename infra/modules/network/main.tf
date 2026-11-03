# A private VPC for Cloud SQL private IP and Cloud Run direct VPC egress. No public database address.

variable "project_id" { type = string }
variable "region" { type = string }
variable "name" { type = string }

resource "google_compute_network" "vpc" {
  project                 = var.project_id
  name                    = var.name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "run" {
  project                  = var.project_id
  name                     = "${var.name}-run"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = "10.10.0.0/24"
  private_ip_google_access = true
}

# Private services access: the range Cloud SQL takes its private IP from.
resource "google_compute_global_address" "sql_range" {
  project       = var.project_id
  name          = "${var.name}-sql-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "sql" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql_range.name]
}

output "network_id" { value = google_compute_network.vpc.id }
output "subnetwork_id" { value = google_compute_subnetwork.run.id }
output "private_services_connection" { value = google_service_networking_connection.sql.id }
