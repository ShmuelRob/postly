# Production: limited access, separate from agent environments (technical-design.md). Not applied by any
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
  #   prefix = "postly/prod"
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
  env_name                  = "prod"
  public_base_url           = var.public_base_url
  business_number           = var.business_number
  github_repository         = var.github_repository
  alert_email               = var.alert_email
  sql_tier                  = "db-custom-2-7680"
  sql_high_availability     = true
  deletion_protection       = true
  worker_max_instances      = 2
  media_noncurrent_days     = 30
  media_coldline_after_days = 180
}

output "postly" { value = module.postly }
