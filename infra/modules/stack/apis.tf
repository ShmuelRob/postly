# The project APIs the stack needs. Never disabled on destroy, so destroying one environment never
# switches off an API something else in the project uses.

locals {
  apis = [
    "run", "sqladmin", "compute", "servicenetworking", "secretmanager", "artifactregistry", "iam",
    "iamcredentials", "sts", "monitoring", "logging", "cloudresourcemanager", "storage",
    "aiplatform", # Gemini through Vertex AI, called as the service account (no API key)
    "iap",        # console sign-in (docs/security.md, "Console exposure")
  ]
}

resource "google_project_service" "this" {
  for_each           = toset(local.apis)
  project            = var.project_id
  service            = "${each.key}.googleapis.com"
  disable_on_destroy = false
}
