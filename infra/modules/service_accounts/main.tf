# One service account per process, each with only what it needs (docs/deployment.md, IAM). Secret,
# bucket and image access are granted on the resource itself in the stack module, not project-wide.

variable "project_id" { type = string }
variable "prefix" { type = string }

locals {
  accounts = {
    web     = "Postly web process (Fastify)"
    worker  = "Postly worker process (pg-boss)"
    console = "Postly console process (internal only)"
    migrate = "Postly migration job"
    deploy  = "Postly deploy from GitHub Actions (Workload Identity Federation)"
  }
  # Project-level roles of the runtime accounts: connect to Cloud SQL, write logs, metrics and traces.
  runtime_roles = ["roles/cloudsql.client", "roles/logging.logWriter", "roles/monitoring.metricWriter", "roles/cloudtrace.agent"]
  # Only the processes that run model tasks call Gemini on Vertex AI; the migration job does not.
  runtime_bindings = merge(
    { for pair in setproduct(["web", "worker", "console", "migrate"], local.runtime_roles) : "${pair[0]}-${pair[1]}" => { account = pair[0], role = pair[1] } },
    { for account in ["web", "worker"] : "${account}-roles/aiplatform.user" => { account = account, role = "roles/aiplatform.user" } },
  )
}

resource "google_service_account" "this" {
  for_each     = local.accounts
  project      = var.project_id
  account_id   = "${var.prefix}-${each.key}"
  display_name = each.value
}

resource "google_project_iam_member" "runtime" {
  for_each = local.runtime_bindings
  project  = var.project_id
  role     = each.value.role
  member   = "serviceAccount:${google_service_account.this[each.value.account].email}"
}

# The deploy account updates Cloud Run services and jobs and acts as the runtime accounts. It has no
# data access: no secret, no bucket, no database.
resource "google_project_iam_member" "deploy_run" {
  project = var.project_id
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.this["deploy"].email}"
}

resource "google_service_account_iam_member" "deploy_acts_as" {
  for_each           = toset(["web", "worker", "console", "migrate"])
  service_account_id = google_service_account.this[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.this["deploy"].email}"
}

output "emails" { value = { for k, sa in google_service_account.this : k => sa.email } }
output "names" { value = { for k, sa in google_service_account.this : k => sa.name } }
