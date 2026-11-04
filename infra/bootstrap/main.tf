# Creates the versioned, private Terraform state bucket for one GCP project, on local state (this
# root's own state is just the bucket). Apply it once per project before the environment
# (docs/deployment.md, What the human does).

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
variable "region" {
  type    = string
  default = "me-west1"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_project_service" "storage" {
  project            = var.project_id
  service            = "storage.googleapis.com"
  disable_on_destroy = false
}

# The environment state holds generated secret values (stack/secret_values.tf), so the bucket is
# private and versioned, and public access is blocked.
resource "google_storage_bucket" "state" {
  project                     = var.project_id
  name                        = "${var.project_id}-tfstate"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  versioning {
    enabled = true
  }
  lifecycle_rule {
    condition {
      num_newer_versions = 20
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }
  depends_on = [google_project_service.storage]
}

output "state_bucket" { value = google_storage_bucket.state.name }
