# One Postly environment (docs/deployment.md): network, Artifact Registry, service accounts,
# Secret Manager secrets (names only), Cloud SQL, the media bucket, the web and worker services, the
# migration job, and monitoring. Each environment in ../../environments calls this module once.

terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.20, < 8.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6, < 4.0"
    }
  }
}

variable "project_id" { type = string }
variable "region" { type = string }
variable "env_name" {
  description = "dev, stage or prod."
  type        = string
  validation {
    condition     = contains(["dev", "stage", "prod"], var.env_name)
    error_message = "The env_name must be dev, stage or prod."
  }
}
variable "image_tag" {
  description = "Image tag for the first creation; later deploys change it through the deploy workflow."
  type        = string
  default     = "bootstrap"
}
variable "public_base_url" {
  description = "The public HTTPS base URL of the web service (provider webhooks, media links). Null uses the web service's run.app URL."
  type        = string
  default     = null
}
variable "business_number" {
  description = "Postly's WhatsApp business number for this environment (a test number on dev and stage)."
  type        = string
}
variable "sql_tier" { type = string }
variable "sql_high_availability" { type = bool }
variable "sql_max_connections" {
  description = "Cloud SQL max_connections; 400 is Postgres' default for db-custom-2-7680 (7.5 GB)."
  type        = number
  default     = 400
}
variable "deletion_protection" { type = bool }
variable "web_max_instances" {
  description = "Web instances; bursts are durable (T2), so several are safe. See docs/deployment.md."
  type        = number
  default     = 1
  validation {
    condition     = var.web_max_instances >= 1 && var.web_max_instances <= 10
    error_message = "web_max_instances must be between 1 and 10."
  }
}
variable "worker_max_instances" {
  type    = number
  default = 2
}
variable "media_noncurrent_days" { type = number }
variable "media_coldline_after_days" { type = number }
variable "sql_retained_backups" {
  description = "Automated Cloud SQL backups kept."
  type        = number
  default     = 14
}
variable "log_retention_days" {
  description = "Retention of the project's _Default log bucket; null leaves the GCP default (30 days)."
  type        = number
  default     = null
}
variable "alert_email" {
  type    = string
  default = null
}

data "google_project" "this" {
  project_id = var.project_id
  depends_on = [google_project_service.this]
}

locals {
  prefix = "postly-${var.env_name}"
  # The branch that deploys to this environment (docs/deployment.md, Branches and promotion).
  deploy_branch = { dev = "dev", stage = "stage", prod = "main" }[var.env_name]
  # Cloud Run's deterministic URL: https://<service>-<project number>.<region>.run.app.
  public_base_url = coalesce(var.public_base_url, "https://${local.prefix}-web-${data.google_project.this.number}.${var.region}.run.app")
  # Every database login of database-schema.md (Least privilege) plus the pg-boss login; the
  # migration job sets their passwords from these secrets. Kept in step with ALL_LOGINS in src/db/index.ts.
  logins = [
    "app_messaging", "app_workflow", "app_content", "app_design", "app_approval", "app_publishing",
    "app_model", "app_billing", "app_business_data", "app_deletion", "app_sys_phone_lookup", "app_sys_scheduler",
    "app_sys_console", "app_sys_example_set", "app_jobs",
  ]
  login_secrets = { for login in local.logins : "db-password-${replace(login, "_", "-")}" => "DB_PASSWORD_${upper(login)}" }
  # The console process's logins (docs/security.md, D9); kept in step with PROCESS_LOGINS.console in src/db/index.ts.
  console_logins        = ["app_sys_console", "app_workflow", "app_publishing", "app_billing", "app_messaging", "app_jobs"]
  console_login_secrets = { for login in local.console_logins : "db-password-${replace(login, "_", "-")}" => "DB_PASSWORD_${upper(login)}" }
  # Vendor credentials for WP-41; the processes do not read them until the adapters exist.
  vendor_secrets = ["messaging-webhook-secret", "messaging-auth-token", "publishing-api-key", "payment-api-key", "payment-webhook-secret"]
  image          = "${module.registry.repository_url}/postly:${var.image_tag}"
  app_env = {
    POSTLY_ENV       = var.env_name
    POSTLY_PROVIDERS = "simulators"
    DATABASE_URL     = "postgres://${module.sql.private_ip}:5432/postly?sslmode=require"
    PUBLIC_BASE_URL  = local.public_base_url
    BUSINESS_NUMBER  = var.business_number
    MEDIA_BUCKET     = module.storage.name
    DB_POOL_MAX      = tostring(local.pool_max)
  }
  app_secret_env = merge(
    { for secret, env in local.login_secrets : env => module.secrets.ids[secret] },
    # The processes refuse to start in dev, stage or prod without it (src/config.ts).
    { MESSAGING_WEBHOOK_SECRET = module.secrets.ids["messaging-webhook-secret"] },
  )
  # The console reads only its own logins' passwords (D9).
  console_secret_env = merge(
    { for secret, env in local.console_login_secrets : env => module.secrets.ids[secret] },
    { MESSAGING_WEBHOOK_SECRET = module.secrets.ids["messaging-webhook-secret"] },
  )
}

module "network" {
  depends_on = [google_project_service.this]
  source     = "../network"
  project_id = var.project_id
  region     = var.region
  name       = local.prefix
}

module "registry" {
  depends_on = [google_project_service.this]
  source     = "../artifact_registry"
  project_id = var.project_id
  region     = var.region
  name       = local.prefix
}

module "accounts" {
  depends_on = [google_project_service.this]
  source     = "../service_accounts"
  project_id = var.project_id
  prefix     = local.prefix
}

module "secrets" {
  depends_on = [google_project_service.this]
  source     = "../secrets"
  project_id = var.project_id
  prefix     = local.prefix
  secrets = merge(
    { for secret, _ in local.login_secrets : secret => concat(
      [module.accounts.emails.web, module.accounts.emails.worker, module.accounts.emails.migrate],
      contains(keys(local.console_login_secrets), secret) ? [module.accounts.emails.console] : [],
    ) },
    # Only the migration job reads the admin password.
    { "db-admin-url" = [module.accounts.emails.migrate] },
    { for name in local.vendor_secrets : name => concat(
      [module.accounts.emails.web, module.accounts.emails.worker],
      # The console process loads the webhook secret with its config, and nothing else of the vendors'.
      name == "messaging-webhook-secret" ? [module.accounts.emails.console] : [],
    ) },
  )
}

module "sql" {
  source                      = "../cloud_sql"
  project_id                  = var.project_id
  region                      = var.region
  name                        = local.prefix
  network_id                  = module.network.network_id
  private_services_connection = module.network.private_services_connection
  tier                        = var.sql_tier
  high_availability           = var.sql_high_availability
  max_connections             = var.sql_max_connections
  deletion_protection         = var.deletion_protection
  retained_backups            = var.sql_retained_backups
}

module "storage" {
  depends_on          = [google_project_service.this]
  source              = "../storage"
  project_id          = var.project_id
  region              = var.region
  name                = "${var.project_id}-${local.prefix}-media"
  force_destroy       = !var.deletion_protection
  noncurrent_days     = var.media_noncurrent_days
  coldline_after_days = var.media_coldline_after_days
}

# Media: web and worker read and write objects; nobody else, and never public.
resource "google_storage_bucket_iam_member" "media" {
  for_each = toset(["web", "worker"])
  bucket   = module.storage.name
  role     = "roles/storage.objectUser"
  member   = "serviceAccount:${module.accounts.emails[each.key]}"
}

# Image pull for the runtime accounts, image push for the deploy account, on this repository only.
resource "google_artifact_registry_repository_iam_member" "pull" {
  for_each   = toset(["web", "worker", "console", "migrate"])
  project    = var.project_id
  location   = var.region
  repository = module.registry.repository_id
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${module.accounts.emails[each.key]}"
}

resource "google_artifact_registry_repository_iam_member" "push" {
  project    = var.project_id
  location   = var.region
  repository = module.registry.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${module.accounts.emails.deploy}"
}

# Connection budget (docs/deployment.md, Sizing; docs/security.md, D7): per instance, pool_max per
# database login the process uses (createDatabase) + pg-boss 10 (poolConnections in src/db/index.ts);
# web and worker use every login, the console only console_logins (one instance); plus the migrate job
# (11) and connections Cloud SQL reserves for itself (10).
locals {
  pool_max                = 3
  connections_per_process = (length(local.logins) - 1) * local.pool_max + 10
  connections_console     = (length(local.console_logins) - 1) * local.pool_max + 10
  connections_needed      = (var.web_max_instances + var.worker_max_instances) * local.connections_per_process + local.console_max_instances * local.connections_console + 11 + 10
  console_max_instances   = 1
}

resource "terraform_data" "connection_budget" {
  input = local.connections_needed
  lifecycle {
    precondition {
      condition     = local.connections_needed <= var.sql_max_connections
      error_message = "The process pools need more connections than Cloud SQL max_connections allows (docs/deployment.md, Sizing)."
    }
  }
}

module "web" {
  source          = "../cloud_run"
  project_id      = var.project_id
  region          = var.region
  name            = "${local.prefix}-web"
  kind            = "service"
  image           = local.image
  command         = "web"
  service_account = module.accounts.emails.web
  subnetwork_id   = module.network.subnetwork_id
  env             = local.app_env
  secret_env      = local.app_secret_env
  public          = true
  min_instances   = 1
  max_instances   = var.web_max_instances
  cpu             = "1"
  memory          = "2Gi"
  depends_on      = [google_secret_manager_secret_version.generated, google_secret_manager_secret_version.admin_url]
}

module "worker" {
  source          = "../cloud_run"
  project_id      = var.project_id
  region          = var.region
  name            = "${local.prefix}-worker"
  kind            = "service"
  image           = local.image
  command         = "worker"
  service_account = module.accounts.emails.worker
  subnetwork_id   = module.network.subnetwork_id
  env             = local.app_env
  secret_env      = local.app_secret_env
  public          = false
  min_instances   = 1
  max_instances   = var.worker_max_instances
  cpu             = "2"
  memory          = "4Gi"
  depends_on      = [google_secret_manager_secret_version.generated, google_secret_manager_secret_version.admin_url]
}

# The console (docs/security.md, "Console exposure"): its own service, because ingress is per service
# and web must stay public. Internal-only ingress and no allUsers invoker; reached with
# an identity token from inside the VPC (docs/security.md); not from a laptop. Its own account reads only
# its own logins' passwords (D9).
module "console" {
  source               = "../cloud_run"
  project_id           = var.project_id
  region               = var.region
  name                 = "${local.prefix}-console"
  kind                 = "service"
  image                = local.image
  command              = "console"
  service_account      = module.accounts.emails.console
  subnetwork_id        = module.network.subnetwork_id
  env                  = local.app_env
  secret_env           = local.console_secret_env
  public               = false
  max_instances        = local.console_max_instances
  cpu_always_allocated = false
  depends_on           = [google_secret_manager_secret_version.generated, google_secret_manager_secret_version.admin_url]
}

module "migrate" {
  source          = "../cloud_run"
  project_id      = var.project_id
  region          = var.region
  name            = "${local.prefix}-migrate"
  kind            = "job"
  image           = local.image
  command         = "migrate"
  service_account = module.accounts.emails.migrate
  subnetwork_id   = module.network.subnetwork_id
  env             = local.app_env
  secret_env      = merge(local.app_secret_env, { MIGRATE_ADMIN_URL = module.secrets.ids["db-admin-url"] })
  depends_on      = [google_secret_manager_secret_version.generated, google_secret_manager_secret_version.admin_url]
}

module "monitoring" {
  depends_on   = [google_project_service.this]
  source       = "../monitoring"
  project_id   = var.project_id
  env_name     = var.env_name
  web_host     = trimsuffix(trimprefix(local.public_base_url, "https://"), "/")
  web_service  = module.web.name
  sql_instance = module.sql.instance_name
  alert_email  = var.alert_email
}

output "image_repository" { value = module.registry.repository_url }
output "web_url" { value = module.web.uri }
output "console_service" { value = module.console.name }
output "sql_connection_name" { value = module.sql.connection_name }
output "media_bucket" { value = module.storage.name }
output "deploy_service_account" { value = module.accounts.emails.deploy }
output "secret_ids" { value = module.secrets.ids }
output "public_base_url" { value = local.public_base_url }
output "project_id" { value = var.project_id }
output "region" { value = var.region }

# Shorter log retention for cheap environments (dev); prod and stage keep the GCP default.
resource "google_logging_project_bucket_config" "default" {
  count          = var.log_retention_days == null ? 0 : 1
  depends_on     = [google_project_service.this]
  project        = var.project_id
  location       = "global"
  bucket_id      = "_Default"
  retention_days = var.log_retention_days
}
