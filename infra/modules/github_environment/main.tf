# The GitHub environment the deploy workflow runs in, named like the Postly environment: deployable
# from `main` only, with required reviewers where given (stage and prod), and the four variables
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

resource "github_repository_environment_deployment_policy" "main" {
  repository     = local.repository
  environment    = github_repository_environment.this.environment
  branch_pattern = "main"
}

resource "github_actions_environment_variable" "this" {
  for_each      = var.variables
  repository    = local.repository
  environment   = github_repository_environment.this.environment
  variable_name = each.key
  value         = each.value
}
