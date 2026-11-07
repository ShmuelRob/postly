# Images come from the one Artifact Registry repository every environment shares (docs/deployment.md,
# CI), created by the dev root in dev's project (modules/artifact_registry). Dev builds and pushes
# once; stage and prod deploy the same digest and can only read. Every binding is on that repository,
# never on its project.

variable "image_registry" {
  description = "The shared image repository: the project, location and repository id (the dev root's module.images.repository)."
  type = object({
    project_id    = string
    location      = string
    repository_id = string
  })
}

locals {
  image_repository_url = "${var.image_registry.location}-docker.pkg.dev/${var.image_registry.project_id}/${var.image_registry.repository_id}"
  # Only dev's deploy account pushes and tags; stage's and prod's read, to find a digest.
  deploy_registry_role = var.env_name == "dev" ? "roles/artifactregistry.writer" : "roles/artifactregistry.reader"
  image_readers = merge(
    { for name in ["web", "worker", "console", "migrate"] : name => "serviceAccount:${module.accounts.emails[name]}" },
    # Cloud Run pulls with this project's Cloud Run service agent; a repository in another project
    # (stage, prod) must grant it read, or no revision starts.
    { cloud_run_agent = "serviceAccount:service-${data.google_project.this.number}@serverless-robot-prod.iam.gserviceaccount.com" },
  )
}

resource "google_artifact_registry_repository_iam_member" "pull" {
  for_each   = local.image_readers
  project    = var.image_registry.project_id
  location   = var.image_registry.location
  repository = var.image_registry.repository_id
  role       = "roles/artifactregistry.reader"
  member     = each.value
}

resource "google_artifact_registry_repository_iam_member" "deploy" {
  project    = var.image_registry.project_id
  location   = var.image_registry.location
  repository = var.image_registry.repository_id
  role       = local.deploy_registry_role
  member     = "serviceAccount:${module.accounts.emails.deploy}"
}

# Dev's per-environment repository `postly-dev`, from before the shared one: Terraform forgets it
# without deleting it, so the running revisions keep their images until the first deploy from the
# shared repository. The human deletes it after that deploy (docs/deployment.md, CI). Stage and prod
# never applied it, so this is a no-op there.
removed {
  from = module.registry
  lifecycle {
    destroy = false
  }
}
