# Secret Manager secrets by name only. Terraform never holds a value: the human adds each version
# (gcloud secrets versions add) after the first apply. Each secret is readable only by the accounts
# listed for it.

variable "project_id" { type = string }
variable "prefix" { type = string }
variable "secrets" {
  description = "Secret id suffix => service account emails that may read it."
  type        = map(list(string))
}

resource "google_secret_manager_secret" "this" {
  for_each  = var.secrets
  project   = var.project_id
  secret_id = "${var.prefix}-${each.key}"
  replication {
    auto {}
  }
}

locals {
  readers = merge([for name, emails in var.secrets : { for email in emails : "${name}/${email}" => { name = name, email = email } }]...)
}

resource "google_secret_manager_secret_iam_member" "reader" {
  for_each  = local.readers
  project   = var.project_id
  secret_id = google_secret_manager_secret.this[each.value.name].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.email}"
}

output "ids" { value = { for k, s in google_secret_manager_secret.this : k => s.secret_id } }
