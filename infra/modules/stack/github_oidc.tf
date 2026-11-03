# Workload Identity Federation for the deploy workflow: GitHub Actions in the named repository, and
# only its protected environment of the same name, may act as the deploy service account. No key file.

variable "github_repository" {
  description = "owner/name of the GitHub repository allowed to deploy."
  type        = string
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "${local.prefix}-github"
  display_name              = "GitHub Actions (${var.env_name})"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"
  attribute_mapping = {
    "google.subject"        = "assertion.sub"
    "attribute.repository"  = "assertion.repository"
    "attribute.environment" = "assertion.environment"
  }
  # Only jobs of this repository that run in the approval-guarded environment of this name.
  attribute_condition = "assertion.repository == \"${var.github_repository}\" && assertion.environment == \"${var.env_name}\""
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_deploy" {
  service_account_id = module.accounts.names.deploy
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

output "workload_identity_provider" { value = google_iam_workload_identity_pool_provider.github.name }
