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
variable "sandbox_enabled" {
  description = "The dev sandbox service (WP-51, docs/deployment.md \"The sandbox\"); only dev may set it."
  type        = bool
  default     = false
  validation {
    condition     = !var.sandbox_enabled || var.env_name == "dev"
    error_message = "The sandbox runs only in dev: stage and prod never run on the simulators."
  }
}
variable "sandbox_invokers" {
  description = "Who may invoke the sandbox, for example [\"user:you@example.com\"]; nobody else, never allUsers."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for m in var.sandbox_invokers : !contains(["allUsers", "allAuthenticatedUsers"], m)])
    error_message = "The sandbox must not be public: list people or service accounts, never allUsers or allAuthenticatedUsers."
  }
}
variable "sandbox_owner_phone" {
  description = "The number the human plays in the sandbox (a test number)."
  type        = string
  default     = "+972500000001"
}
variable "sandbox_url" {
  description = "Where payment links point: the sandbox as the human reaches it (gcloud run services proxy on port 8081)."
  type        = string
  default     = "http://localhost:8081"
}
variable "alert_email" {
  type    = string
  default = null
}
variable "console_iap_client_id" {
  description = "The OAuth client id made by hand for IAP (docs/deployment.md, Console sign-in). Null creates no load balancer: the console stays unreachable."
  type        = string
  default     = null
}
variable "console_domain" {
  description = "The console's domain, with a Google-managed certificate. Null uses <ip>.sslip.io (dev only)."
  type        = string
  default     = null
  validation {
    # sslip.io is a third party's DNS; it may only stand in for a domain on dev (docs/security.md).
    condition     = var.console_domain != null || var.console_iap_client_id == null || var.env_name == "dev"
    error_message = "Stage and prod need console_domain; the sslip.io fallback is for dev only."
  }
}
variable "console_members" {
  description = "Who passes IAP to the console: user:<email>, group:<email> or domain:<domain>. Empty lets nobody in."
  type        = list(string)
  default     = []
}

data "google_project" "this" {
  project_id = var.project_id
  depends_on = [google_project_service.this]
}

locals {
  prefix = "postly-${var.env_name}"
  # Simulated mode (WP-51, docs/deployment.md): dev runs on the simulators with their state in Postgres;
  # stage and prod are set to vendors, which refuses to start until WP-41.
  simulated = var.env_name == "dev"
  # The branch that deploys to this environment (docs/deployment.md, Branches and promotion).
  deploy_branch = { dev = "dev", stage = "stage", prod = "main" }[var.env_name]
  # Cloud Run's deterministic URL: https://<service>-<project number>.<region>.run.app.
  public_base_url = coalesce(var.public_base_url, "https://${local.prefix}-web-${data.google_project.this.number}.${var.region}.run.app")
  # Every database login of database-schema.md (Least privilege) plus the pg-boss login; the
  # migration job sets their passwords from these secrets. Kept in step with ALL_LOGINS in src/db/index.ts.
  base_logins = [
    "app_messaging", "app_workflow", "app_content", "app_design", "app_approval", "app_publishing",
    "app_model", "app_billing", "app_business_data", "app_deletion", "app_sys_phone_lookup", "app_sys_scheduler",
    "app_sys_console", "app_sys_example_set", "app_jobs",
  ]
  # The simulator store's login (src/db/simulator-store.ts) exists only where the simulators run.
  logins        = concat(local.base_logins, local.simulated ? ["app_simulator"] : [])
  login_secrets = { for login in local.logins : "db-password-${replace(login, "_", "-")}" => "DB_PASSWORD_${upper(login)}" }
  # The console process's logins (docs/security.md, D9); kept in step with PROCESS_LOGINS.console in src/db/index.ts.
  # In simulated mode the console also needs the simulator store's login, which loadConfig requires
  # with SIMULATOR_STORE=postgres (WP-51).
  console_base_logins   = ["app_sys_console", "app_workflow", "app_publishing", "app_billing", "app_messaging", "app_jobs"]
  console_logins        = concat(local.console_base_logins, local.simulated ? ["app_simulator"] : [])
  console_login_secrets = { for login in local.console_logins : "db-password-${replace(login, "_", "-")}" => "DB_PASSWORD_${upper(login)}" }
  # Vendor credentials for WP-41; the processes do not read them until the adapters exist.
  # Dev on the simulators has no vendor secrets; the simulators sign with messaging-webhook-secret.
  vendor_secrets = concat(["messaging-webhook-secret"], local.simulated ? [] : ["messaging-auth-token", "publishing-api-key", "payment-api-key", "payment-webhook-secret"])
  image          = "${module.registry.repository_url}/postly:${var.image_tag}"
  app_env = merge({
    POSTLY_ENV       = var.env_name
    POSTLY_PROVIDERS = local.simulated ? "simulators" : "vendors"
    DATABASE_URL     = "postgres://${module.sql.private_ip}:5432/postly?sslmode=require"
    PUBLIC_BASE_URL  = local.public_base_url
    BUSINESS_NUMBER  = var.business_number
    MEDIA_BUCKET     = module.storage.name
    }, local.simulated ? {
    SIMULATOR_STORE = "postgres"
    POSTLY_MODELS   = "simulator"
    SANDBOX_URL     = var.sandbox_url
  } : {})
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
    # Read only by Terraform, into the console backend's IAP settings; no service account reads it.
    { "console-iap-client-secret" = [] },
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

# Connection budget (docs/deployment.md, Sizing): each login x 3 (createDatabase) + pg-boss 10 per
# process, plus the migrate job (11) and connections Cloud SQL reserves for itself (10).
locals {
  connections_per_process = length(local.logins) * 3 + 10
  connections_needed      = (var.web_max_instances + var.worker_max_instances) * local.connections_per_process + 11 + 10
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

# The dev sandbox (WP-51, docs/deployment.md "The sandbox"): its own image, built only for dev; no
# allUsers invoker, only sandbox_invokers, reached with `gcloud run services proxy`. Runs as the web
# account: it needs the same login passwords and the webhook secret.
module "sandbox" {
  count                = var.sandbox_enabled ? 1 : 0
  source               = "../cloud_run"
  project_id           = var.project_id
  region               = var.region
  name                 = "${local.prefix}-sandbox"
  kind                 = "service"
  image                = "${module.registry.repository_url}/postly-sandbox:${var.image_tag}"
  command              = "sandbox"
  service_account      = module.accounts.emails.web
  subnetwork_id        = module.network.subnetwork_id
  env                  = merge(local.app_env, { SANDBOX_OWNER_PHONE = var.sandbox_owner_phone })
  secret_env           = local.app_secret_env
  public               = false
  external_ingress     = true
  cpu_always_allocated = false
  depends_on           = [google_secret_manager_secret_version.generated, google_secret_manager_secret_version.admin_url]
}

# The console (docs/security.md, "Console exposure"): its own service, because ingress is per service
# and web must stay public. Ingress internal and load balancer, no allUsers invoker: team members come
# in through the load balancer with IAP (console_ingress). Its own account reads only
# its own logins' passwords (D9).
locals {
  console_enabled = var.console_iap_client_id != null
  console_env = merge(
    local.app_env,
    { CONSOLE_AUTH = "iap" },
    local.console_enabled ? { CONSOLE_IAP_AUDIENCE = module.console_ingress[0].audience, CONSOLE_HOST = module.console_ingress[0].domain } : {},
  )
}

module "console_ingress" {
  count                  = local.console_enabled ? 1 : 0
  depends_on             = [google_project_service.this]
  source                 = "../console_ingress"
  project_id             = var.project_id
  project_number         = data.google_project.this.number
  region                 = var.region
  prefix                 = local.prefix
  service_name           = "${local.prefix}-console"
  domain                 = var.console_domain
  members                = var.console_members
  oauth_client_id        = var.console_iap_client_id
  oauth_client_secret_id = module.secrets.ids["console-iap-client-secret"]
}

# Only IAP's service agent may invoke the console.
resource "google_cloud_run_v2_service_iam_member" "console_iap_invoker" {
  count    = local.console_enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = module.console.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${module.console_ingress[0].iap_service_agent}"
  # The module's name output is only a string; wait for the service itself.
  depends_on = [module.console]
}

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
  env                  = local.console_env
  secret_env           = local.console_secret_env
  public               = false
  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  cpu_always_allocated = false
  depends_on           = [google_secret_manager_secret_version.generated, google_secret_manager_secret_version.admin_url]
}

resource "google_cloud_run_v2_service_iam_member" "sandbox" {
  for_each = var.sandbox_enabled ? toset(var.sandbox_invokers) : toset([])
  project  = var.project_id
  location = var.region
  name     = module.sandbox[0].name
  role     = "roles/run.invoker"
  member   = each.value
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

  worker_service      = module.worker.name
  sql_max_connections = var.sql_max_connections
}

output "image_repository" { value = module.registry.repository_url }
output "web_url" { value = module.web.uri }
output "sandbox_service" { value = var.sandbox_enabled ? module.sandbox[0].name : null }
output "console_service" { value = module.console.name }
output "console_url" { value = local.console_enabled ? module.console_ingress[0].url : null }
output "console_ip" { value = local.console_enabled ? module.console_ingress[0].ip : null }
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
