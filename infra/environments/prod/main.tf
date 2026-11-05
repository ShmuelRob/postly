# Production: limited access, separate from agent environments (technical-design.md). Not applied by any
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
    prefix = "postly/prod"
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
  env_name          = "prod"
  public_base_url   = var.public_base_url
  app_metric_alerts = var.app_metric_alerts
  business_number   = var.business_number
  github_repository = var.github_repository
  alert_email       = var.alert_email
  # Console sign-in (docs/deployment.md, Console sign-in: one-time steps).
  console_iap_client_id     = var.console_iap_client_id
  console_domain            = var.console_domain
  console_members           = var.console_members
  sql_tier                  = "db-custom-2-7680"
  sql_high_availability     = false
  deletion_protection       = true
  worker_max_instances      = 2
  media_noncurrent_days     = 7
  media_coldline_after_days = 180
}

module "github" {
  source      = "../../modules/github_environment"
  repository  = var.github_repository
  environment = "prod"
  branch      = module.postly.deploy_branch
  reviewers   = var.deploy_reviewers
  variables = {
    GCP_PROJECT_ID                 = var.project_id
    GCP_REGION                     = var.region
    GCP_WORKLOAD_IDENTITY_PROVIDER = module.postly.workload_identity_provider
    GCP_DEPLOY_SERVICE_ACCOUNT     = module.postly.deploy_service_account
  }
}

output "postly" { value = module.postly }
