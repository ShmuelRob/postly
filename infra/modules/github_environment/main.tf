# The GitHub environment the deploy workflow runs in, named like the Postly environment: deployable
# only from its own branch (dev, stage, or main for prod), which is created here and protected, with required reviewers where given (stage and prod), and the four variables
# the workflow reads. This is the real deploy gate (docs/deployment.md, IAM). The provider token
# comes from the GITHUB_TOKEN environment variable, never from tfvars.

terraform {
  required_version = ">= 1.9"
  required_providers {
    github = {
      source  = "integrations/github"
      version = ">= 6.4, < 7.0"
    }
  }
}

variable "repository" {
  description = "owner/name."
  type        = string
}
variable "environment" { type = string }
variable "branch" {
  description = "The branch that deploys to this environment; created from main unless it is main."
  type        = string
}
variable "reviewers" {
  description = "GitHub usernames that must approve a deploy; empty means none (dev)."
  type        = list(string)
}
variable "variables" {
  description = "Environment variables for the deploy workflow (not secrets)."
  type        = map(string)
}

locals {
  repository = split("/", var.repository)[1]
}

data "github_user" "reviewer" {
  for_each = toset(var.reviewers)
  username = each.key
}

resource "github_repository_environment" "this" {
  repository  = local.repository
  environment = var.environment

  dynamic "reviewers" {
    for_each = length(var.reviewers) > 0 ? [1] : []
    content {
      users = [for u in data.github_user.reviewer : tonumber(u.id)]
    }
  }

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "branch" {
  repository     = local.repository
  environment    = github_repository_environment.this.environment
  branch_pattern = var.branch
}

data "github_repository" "this" {
  full_name = var.repository
}

resource "github_branch" "this" {
  count         = var.branch == "main" ? 0 : 1
  repository    = local.repository
  branch        = var.branch
  source_branch = "main"
}

# Code reaches the branch only through a pull request with the CI `check` job passing.
resource "github_branch_protection" "this" {
  repository_id    = data.github_repository.this.node_id
  pattern          = var.branch
  enforce_admins   = true
  allows_deletions = false

  required_status_checks {
    strict   = false
    contexts = ["check"]
  }

  required_pull_request_reviews {
    required_approving_review_count = 0
  }

  depends_on = [github_branch.this]
}

resource "github_actions_environment_variable" "this" {
  for_each      = var.variables
  repository    = local.repository
  environment   = github_repository_environment.this.environment
  variable_name = each.key
  value         = each.value
}
