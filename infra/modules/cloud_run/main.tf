# One Cloud Run service or job running the Postly image with a given command (web, worker, migrate).
# Secrets are mounted as environment variables from Secret Manager (latest version). Direct VPC
# egress reaches Cloud SQL's private IP. The image tag is changed by the deploy workflow, so
# Terraform ignores it after creation.

variable "project_id" { type = string }
variable "region" { type = string }
variable "name" { type = string }
variable "kind" {
  description = "service (web, worker) or job (migrate)."
  type        = string
  validation {
    condition     = contains(["service", "job"], var.kind)
    error_message = "The kind must be service or job."
  }
}
variable "image" { type = string }
variable "command" { type = string }
variable "service_account" { type = string }
variable "subnetwork_id" { type = string }
variable "env" {
  type    = map(string)
  default = {}
}
variable "secret_env" {
  description = "Env var name => Secret Manager secret id."
  type        = map(string)
  default     = {}
}
variable "min_instances" {
  type    = number
  default = 0
}
variable "max_instances" {
  type    = number
  default = 1
}
variable "cpu" {
  type    = string
  default = "1"
}
variable "memory" {
  type    = string
  default = "1Gi"
}
variable "public" {
  description = "Allow unauthenticated requests (only the web service, for the provider webhooks)."
  type        = bool
  default     = false
}
variable "cpu_always_allocated" {
  description = "Keep CPU between requests (the worker polls pg-boss; the web runs the inbound sweep)."
  type        = bool
  default     = true
}

resource "google_cloud_run_v2_service" "this" {
  count               = var.kind == "service" ? 1 : 0
  project             = var.project_id
  name                = var.name
  location            = var.region
  ingress             = var.public ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = false

  template {
    service_account = var.service_account
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        subnetwork = var.subnetwork_id
      }
    }
    containers {
      image = var.image
      args  = [var.command]
      resources {
        limits            = { cpu = var.cpu, memory = var.memory }
        cpu_idle          = !var.cpu_always_allocated
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds    = 5
        failure_threshold = 12
      }
      liveness_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds = 30
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.kind == "service" && var.public ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.this[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_job" "this" {
  count               = var.kind == "job" ? 1 : 0
  project             = var.project_id
  name                = var.name
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1
    template {
      service_account = var.service_account
      max_retries     = 0
      timeout         = "900s"
      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          subnetwork = var.subnetwork_id
        }
      }
      containers {
        image = var.image
        args  = [var.command]
        resources {
          limits = { cpu = var.cpu, memory = var.memory }
        }
        dynamic "env" {
          for_each = var.env
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = var.secret_env
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]
  }
}

output "name" { value = var.name }
output "uri" { value = var.kind == "service" ? google_cloud_run_v2_service.this[0].uri : null }
