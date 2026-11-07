# The one Docker repository shared by every environment (docs/deployment.md, CI): the product image
# `postly` and the dev sandbox image `postly-sandbox`, tagged `tree-<key>` and with the commit SHA.
# Created by the dev root, in dev's project; stage and prod only read it (stack/registry.tf). Built
# once on dev, then the same digest is deployed to stage and prod.

variable "project_id" { type = string }
variable "region" { type = string }
variable "name" { type = string }

resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = var.name
  format        = "DOCKER"
  description   = "Postly images for every environment (built once on dev; stage and prod deploy the same digest)"

  # A tag never moves: tree-<key> names one checked build, so a promotion cannot get other bytes.
  docker_config {
    immutable_tags = true
  }

  # Only untagged manifests are deleted: candidates whose checks failed, and nothing a service runs
  # (every deployed image carries its tree-<key> tag).
  cleanup_policies {
    id     = "delete-old-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "2592000s"
    }
  }

  # Prod pulls from here: destroying the dev root must never take the prod images with it.
  lifecycle {
    prevent_destroy = true
  }
}

output "repository_url" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}
output "repository" {
  value = {
    project_id    = var.project_id
    location      = var.region
    repository_id = google_artifact_registry_repository.images.repository_id
  }
}
