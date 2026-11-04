# Dev: always-on and cheap, simulators or test accounts only; deployable without a reviewer, from
# main only (docs/deployment.md, Environments). Not applied by any
# agent: the human runs the apply (docs/deployment.md, gate H8).

terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.20, < 8.0"
    }
    github = {
      source  = "integrations/github"
      version = ">= 6.4, < 7.0"
    }
  }

  # Partial config: the bucket comes from infra/bootstrap, passed at init:
  #   terraform init -backend-config="bucket=<project_id>-tfstate"
  backend "gcs" {
    prefix = "postly/dev"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# The token comes from the GITHUB_TOKEN environment variable, never from tfvars.
provider "github" {
  owner = split("/", var.github_repository)[0]
}

module "postly" {
  source            = "../../modules/stack"
  project_id        = var.project_id
  region            = var.region
  env_name          = "dev"
  public_base_url   = var.public_base_url
  business_number   = var.business_number
  github_repository = var.github_repository
  alert_email       = var.alert_email
  # Not db-f1-micro: its ~25 connections are too few for 15 logins with per-process pools plus pg-boss.
  sql_tier                  = "db-g1-small"
  sql_high_availability     = false
  deletion_protection       = false
  worker_max_instances      = 1
  media_noncurrent_days     = 3
  media_coldline_after_days = 30
  sql_retained_backups      = 3
  log_retention_days        = 7
}

module "github" {
  source      = "../../modules/github_environment"
  repository  = var.github_repository
  environment = "dev"
  branch      = module.postly.deploy_branch
  reviewers   = []
  variables = {
    GCP_PROJECT_ID                 = var.project_id
    GCP_REGION                     = var.region
    GCP_WORKLOAD_IDENTITY_PROVIDER = module.postly.workload_identity_provider
    GCP_DEPLOY_SERVICE_ACCOUNT     = module.postly.deploy_service_account
  }
}

output "postly" { value = module.postly }
