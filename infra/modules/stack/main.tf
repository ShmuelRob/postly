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
  }
}

variable "project_id" { type = string }
variable "region" { type = string }
variable "env_name" {
  description = "staging or prod."
  type        = string
  validation {
    condition     = contains(["staging", "prod"], var.env_name)
    error_message = "The env_name must be staging or prod."
  }
}
variable "image_tag" {
  description = "Image tag for the first creation; later deploys change it through the deploy workflow."
  type        = string
  default     = "bootstrap"
}
variable "public_base_url" {
  description = "The public HTTPS base URL of the web service (provider webhooks, media links)."
  type        = string
}
variable "business_number" {
  description = "Postly's WhatsApp business number for this environment (a test number on staging)."
  type        = string
}
variable "sql_tier" { type = string }
variable "sql_high_availability" { type = bool }
variable "deletion_protection" { type = bool }
variable "web_max_instances" {
  description = "Must stay 1 until bursts are durable (review queue item 14); see docs/deployment.md."
  type        = number
  default     = 1
  validation {
    condition     = var.web_max_instances == 1
    error_message = "The web service runs one instance until the inbound burst claim is durable (review queue item 14)."
  }
}
variable "worker_max_instances" {
  type    = number
  default = 2
}
variable "media_noncurrent_days" { type = number }
variable "media_coldline_after_days" { type = number }
variable "alert_email" {
  type    = string
  default = null
}

locals {
  prefix = "postly-${var.env_name}"
  # Every database login of database-schema.md (Least privilege) plus the pg-boss login; the
  # migration job sets their passwords from these secrets. Kept in step with ALL_LOGINS in src/db/index.ts.
  logins = [
    "app_messaging", "app_workflow", "app_content", "app_design", "app_approval", "app_publishing",
    "app_model", "app_billing", "app_business_data", "app_sys_phone_lookup", "app_sys_scheduler",
    "app_sys_console", "app_sys_example_set", "app_jobs",
  ]
  login_secrets = { for login in local.logins : "db-password-${replace(login, "_", "-")}" => "DB_PASSWORD_${upper(login)}" }
  # Vendor credentials for WP-41; the processes do not read them until the adapters exist.
  vendor_secrets = ["messaging-auth-token", "publishing-api-key", "model-api-key", "payment-api-key", "payment-webhook-secret"]
  image          = "${module.registry.repository_url}/postly:${var.image_tag}"
  app_env = {
    POSTLY_PROVIDERS = "simulators"
    DATABASE_URL     = "postgres://${module.sql.private_ip}:5432/postly?sslmode=require"
    PUBLIC_BASE_URL  = var.public_base_url
    BUSINESS_NUMBER  = var.business_number
    MEDIA_BUCKET     = module.storage.name
  }
  app_secret_env = { for secret, env in local.login_secrets : env => module.secrets.ids[secret] }
}

module "network" {
  source     = "../network"
  project_id = var.project_id
  region     = var.region
  name       = local.prefix
}

module "registry" {
  source     = "../artifact_registry"
  project_id = var.project_id
  region     = var.region
  name       = local.prefix
}

module "accounts" {
  source     = "../service_accounts"
  project_id = var.project_id
  prefix     = local.prefix
}

module "secrets" {
  source     = "../secrets"
  project_id = var.project_id
  prefix     = local.prefix
  secrets = merge(
    { for secret, _ in local.login_secrets : secret => [module.accounts.emails.web, module.accounts.emails.worker, module.accounts.emails.migrate] },
    # Only the migration job reads the admin password.
    { "db-admin-url" = [module.accounts.emails.migrate] },
    { for name in local.vendor_secrets : name => [module.accounts.emails.web, module.accounts.emails.worker] },
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
  deletion_protection         = var.deletion_protection
}

module "storage" {
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
  for_each   = toset(["web", "worker", "migrate"])
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
  memory          = "2Gi"
  depends_on      = [module.secrets]
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
  memory          = "2Gi"
  depends_on      = [module.secrets]
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
  depends_on      = [module.secrets]
}

module "monitoring" {
  source       = "../monitoring"
  project_id   = var.project_id
  env_name     = var.env_name
  web_host     = trimsuffix(trimprefix(var.public_base_url, "https://"), "/")
  web_service  = module.web.name
  sql_instance = module.sql.instance_name
  alert_email  = var.alert_email
}

output "image_repository" { value = module.registry.repository_url }
output "web_url" { value = module.web.uri }
output "sql_connection_name" { value = module.sql.connection_name }
output "media_bucket" { value = module.storage.name }
output "deploy_service_account" { value = module.accounts.emails.deploy }
output "secret_ids" { value = module.secrets.ids }
