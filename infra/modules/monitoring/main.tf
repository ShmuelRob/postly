# Monitoring and alerting (docs/observability.md, "Dashboards and alerts"): an uptime check on the web
# health endpoint, alerts (main.tf, alerts.tf), log-based metrics (logs.tf), the web availability SLO
# (slo.tf) and the dashboards (dashboards.tf). Alerts go to the email channel the human names (no value
# is committed). Every alert links to its entry in docs/runbook.md. Never applied by an agent.

variable "project_id" { type = string }
variable "env_name" { type = string }
variable "web_host" {
  description = "Host of the web service (from its URL), for the uptime check."
  type        = string
}
variable "web_service" { type = string }
variable "sql_instance" { type = string }
variable "worker_service" { type = string }
variable "sql_max_connections" {
  description = "Cloud SQL max_connections, for the connections-near-max alert."
  type        = number
}
variable "model_cost_hourly_usd" {
  description = "Model spend in one hour above which the cost-spike alert fires."
  type        = number
  default     = 5
}
variable "runbook_url" {
  description = "Base URL of docs/runbook.md; each alert links to <runbook_url>#<anchor>."
  type        = string
  default     = "https://github.com/ShmuelRob/postly/blob/main/docs/runbook.md"
}
variable "app_metric_alerts" {
  description = "Create the alerts on the app's own postly.* metrics. Cloud Monitoring refuses an alert on a metric that has never been written, so this stays false until the first deploy has run and the metrics exist (docs/deploy-dev-guide.md, step 6)."
  type        = bool
  default     = false
}
variable "alert_email" {
  description = "Where alerts go. Null creates no channel (alerts still show in the console)."
  type        = string
  default     = null
}

resource "google_monitoring_notification_channel" "email" {
  count        = var.alert_email == null ? 0 : 1
  project      = var.project_id
  display_name = "Postly ${var.env_name} on-call"
  type         = "email"
  labels       = { email_address = var.alert_email }
}

locals {
  channels = google_monitoring_notification_channel.email[*].name
  runbook  = { for anchor in local.runbook_anchors : anchor => "Runbook: ${var.runbook_url}#${anchor}" }

  runbook_anchors = [
    "web-health-check-failing", "web-5xx-responses", "error-log-lines", "cloud-sql-cpu-or-disk-high",
    "publishing-failures", "webhook-errors", "pgboss-backlog", "worker-not-running", "channel-disconnected",
    "cost-spike", "model-validation-failures", "cloud-sql-connections-near-max", "error-budget-burn",
  ]
}

resource "google_monitoring_uptime_check_config" "web" {
  project      = var.project_id
  display_name = "postly-${var.env_name}-web-healthz"
  timeout      = "10s"
  period       = "60s"
  http_check {
    # Not /healthz: Cloud Run's front end reserves paths ending in "z" and answers them 404 itself.
    path         = "/health"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
  monitored_resource {
    type   = "uptime_url"
    labels = { project_id = var.project_id, host = var.web_host }
  }
}

resource "google_monitoring_alert_policy" "uptime" {
  project               = var.project_id
  display_name          = "Postly ${var.env_name}: web health check failing"
  combiner              = "OR"
  notification_channels = local.channels
  documentation {
    content   = local.runbook["web-health-check-failing"]
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "healthz down"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.web.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
    }
  }
}

resource "google_monitoring_alert_policy" "web_5xx" {
  project               = var.project_id
  display_name          = "Postly ${var.env_name}: web 5xx responses"
  combiner              = "OR"
  notification_channels = local.channels
  documentation {
    content   = local.runbook["web-5xx-responses"]
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "5xx rate"
    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${var.web_service}\" AND metric.label.response_code_class=\"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}

# The processes log JSON lines with level "error" (pg-boss errors, failed weekly ticks, startup).
resource "google_logging_metric" "errors" {
  project = var.project_id
  name    = "postly-${var.env_name}-error-lines"
  filter  = "((resource.type=\"cloud_run_revision\" AND resource.labels.service_name=~\"^postly-${var.env_name}-\") OR (resource.type=\"cloud_run_job\" AND resource.labels.job_name=~\"^postly-${var.env_name}-\")) AND (jsonPayload.level=\"error\" OR severity>=ERROR)"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "errors" {
  project               = var.project_id
  display_name          = "Postly ${var.env_name}: error log lines"
  combiner              = "OR"
  notification_channels = local.channels
  documentation {
    content   = local.runbook["error-log-lines"]
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "errors logged"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.errors.name}\" AND resource.type=one_of(\"cloud_run_revision\", \"cloud_run_job\")"
      comparison      = "COMPARISON_GT"
      threshold_value = 10
      duration        = "0s"
      aggregations {
        alignment_period   = "600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "sql" {
  project               = var.project_id
  display_name          = "Postly ${var.env_name}: Cloud SQL CPU or disk high"
  combiner              = "OR"
  notification_channels = local.channels
  documentation {
    content   = local.runbook["cloud-sql-cpu-or-disk-high"]
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "CPU above 80%"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${var.sql_instance}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "600s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
  conditions {
    display_name = "disk above 85%"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${var.sql_instance}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.85
      duration        = "600s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
}
