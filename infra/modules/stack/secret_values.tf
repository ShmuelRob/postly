# Generated secret values: a random password per database login, the messaging webhook secret, and
# the Cloud SQL `postgres` admin password with the admin URL built from it. They end up in the
# Terraform state, which is acceptable only because the state bucket (infra/bootstrap) is private,
# versioned, and readable only by the project's admins (docs/deployment.md). Vendor secrets get no
# version here: they wait for real vendor accounts (WP-41).

locals {
  generated_secrets = toset(concat(keys(local.login_secrets), ["messaging-webhook-secret"]))
}

# Alphanumeric only, so the values are safe inside a connection URL without escaping.
resource "random_password" "generated" {
  for_each = local.generated_secrets
  length   = 40
  special  = false
}

resource "google_secret_manager_secret_version" "generated" {
  for_each    = local.generated_secrets
  secret      = module.secrets.names[each.key]
  secret_data = random_password.generated[each.key].result
}

resource "random_password" "admin" {
  length  = 40
  special = false
}

resource "google_sql_user" "admin" {
  project  = var.project_id
  instance = module.sql.instance_name
  name     = "postgres"
  password = random_password.admin.result
}

resource "google_secret_manager_secret_version" "admin_url" {
  secret      = module.secrets.names["db-admin-url"]
  secret_data = "postgres://postgres:${random_password.admin.result}@${module.sql.private_ip}:5432/postly?sslmode=require"
  depends_on  = [google_sql_user.admin]
}
