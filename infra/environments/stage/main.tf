# Stage: test accounts and test keys only (technical-design.md, Environments). Not applied by any
# agent: the human runs the first apply (docs/deployment.md, gate H8).

terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.20, < 8.0"
    }
  }

  # Remote state: the human creates the bucket and uncomments this (docs/deployment.md).
  # backend "gcs" {
  #   bucket = "REPLACE_WITH_STATE_BUCKET"
  #   prefix = "postly/stage"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

module "postly" {
  source                    = "../../modules/stack"
  project_id                = var.project_id
  region                    = var.region
  env_name                  = "stage"
  public_base_url           = var.public_base_url
  business_number           = var.business_number
  github_repository         = var.github_repository
  alert_email               = var.alert_email
  sql_tier                  = "db-g1-small"
  sql_high_availability     = false
  deletion_protection       = false
  worker_max_instances      = 1
  media_noncurrent_days     = 7
  media_coldline_after_days = 90
}

output "postly" { value = module.postly }
