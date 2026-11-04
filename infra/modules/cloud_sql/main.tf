# Cloud SQL Postgres 17 with a private IP only. The per-role logins of database-schema.md (Least
# privilege) are not created here: the migrations create them and the migration job sets their
# passwords from Secret Manager. Terraform creates only the instance and the database; the human
# sets the built-in admin user's password (docs/deployment.md).

variable "project_id" { type = string }
variable "region" { type = string }
variable "name" { type = string }
variable "network_id" { type = string }
variable "private_services_connection" {
  description = "The private services connection id; passing it orders the instance after the peering."
  type        = string
}
variable "tier" { type = string }
variable "high_availability" { type = bool }
variable "deletion_protection" { type = bool }
variable "retained_backups" {
  type    = number
  default = 14
}

resource "google_sql_database_instance" "postgres" {
  project             = var.project_id
  name                = var.name
  region              = var.region
  database_version    = "POSTGRES_17"
  deletion_protection = var.deletion_protection

  settings {
    tier              = var.tier
    edition           = "ENTERPRISE"
    availability_type = var.high_availability ? "REGIONAL" : "ZONAL"
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network_id
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "01:00"
      backup_retention_settings {
        retained_backups = var.retained_backups
      }
    }

    maintenance_window {
      day  = 7
      hour = 2
    }

    insights_config {
      query_insights_enabled = true
    }

    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }

    # Must stay "none": the migration job's ALTER ROLE ... PASSWORD statements carry the login
    # passwords, and statement logging would write them to Cloud Logging (docs/deployment.md).
    database_flags {
      name  = "log_statement"
      value = "none"
    }
  }

  lifecycle {
    precondition {
      condition     = var.private_services_connection != ""
      error_message = "The private services connection must exist first."
    }
  }
}

resource "google_sql_database" "postly" {
  project  = var.project_id
  instance = google_sql_database_instance.postgres.name
  name     = "postly"
}

output "instance_name" { value = google_sql_database_instance.postgres.name }
output "connection_name" { value = google_sql_database_instance.postgres.connection_name }
output "private_ip" { value = google_sql_database_instance.postgres.private_ip_address }
