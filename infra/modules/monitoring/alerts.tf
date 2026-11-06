# The WP-49 alerts (docs/observability.md, "Alerts"). Each one links to its docs/runbook.md entry.
# The workload.googleapis.com metrics are WP-48's OpenTelemetry metrics; each environment is its own
# project, so a metric type alone selects this environment.

locals {
  workload = "workload.googleapis.com"
}

resource "google_monitoring_alert_policy" "publishing_failures" {
  # Alert policies on postly.* need the metric to exist; see var.app_metric_alerts.
  count = var.app_metric_alerts ? 1 : 0

  project               = var.project_id
  display_name          = "Postly ${var.env_name}: publishing failure rate"
  combiner              = "AND"
  notification_channels = local.channels
  documentation {
    content   = local.runbook["publishing-failures"]
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "over 20% of publication runs failed in 1h"
    condition_threshold {
      filter             = "metric.type=\"${local.workload}/postly.publications.count\" AND metric.label.outcome=\"failed\" AND resource.type=\"generic_task\""
      denominator_filter = "metric.type=\"${local.workload}/postly.publications.count\" AND metric.label.outcome=monitoring.regex.full_match(\"published|failed\") AND resource.type=\"generic_task\""
      comparison         = "COMPARISON_GT"
      threshold_value    = 0.2
      duration           = "0s"
      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      denominator_aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
  conditions {
    display_name = "at least 3 failed publication runs in 1h"
    condition_threshold {
      filter          = "metric.type=\"${local.workload}/postly.publications.count\" AND metric.label.outcome=\"failed\" AND resource.type=\"generic_task\""
      comparison      = "COMPARISON_GT"
      threshold_value = 2
      duration        = "0s"
      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "webhook_errors" {
  project               = var.project_id
  display_name          = "Postly ${var.env_name}: webhook errors"
  combiner              = "OR"
  notification_channels = local.channels
  documentation {
    content   = local.runbook["webhook-errors"]
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "at least 5 non-2xx webhook responses in 10 min"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.webhook_errors.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 4
      duration        = "0s"
      aggregations {
        alignment_period     = "600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.route"]
      }
    }
  }
}

resource "google_monitoring_alert_policy" "queue_backlog" {
  # Alert policies on postly.* need the metric to exist; see var.app_metric_alerts.
  count = var.app_metric_alerts ? 1 : 0

  project               = var.project_id
  display_name          = "Postly ${var.env_name}: job queue stuck"
  combiner              = "OR"
  notification_channels = local.channels
  documentation {
    content   = local.runbook["pgboss-backlog"]
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "more than 50 queued jobs for 15 min"
    condition_threshold {
      filter          = "metric.type=\"${local.workload}/postly.queue.depth\" AND metric.label.state=\"queued\" AND resource.type=\"generic_task\""
      comparison      = "COMPARISON_GT"
      threshold_value = 50
      duration        = "900s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["metric.label.queue"]
      }
    }
  }
}

resource "google_monitoring_alert_policy" "worker_down" {
  project               = var.project_id
  display_name          = "Postly ${var.env_name}: worker not running"
  combiner              = "OR"
  notification_channels = local.channels
  documentation {
    content   = local.runbook["worker-not-running"]
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "no worker instance for 10 min"
    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/container/instance_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${var.worker_service}\""
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
  conditions {
    display_name = "no worker instance data for 10 min"
    condition_absent {
      filter   = "metric.type=\"run.googleapis.com/container/instance_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${var.worker_service}\""
      duration = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "channel_disconnected" {
  project               = var.project_id
  display_name          = "Postly ${var.env_name}: publishing channel disconnected"
  combiner              = "OR"
  notification_channels = local.channels
  documentation {
    content   = local.runbook["channel-disconnected"]
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "a business channel disconnected"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.channel_disconnected.name}\" AND resource.type=one_of(\"cloud_run_revision\", \"cloud_run_job\")"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.business_id"]
      }
    }
  }
}

resource "google_monitoring_alert_policy" "agent_global_budget" {
  project               = var.project_id
  display_name          = "Postly ${var.env_name}: agent global daily budget reached"
  combiner              = "OR"
  notification_channels = local.channels
  documentation {
    content   = local.runbook["agent-global-budget"]
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "an agent turn stopped at the global daily budget"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.agent_global_budget.name}\" AND resource.type=one_of(\"cloud_run_revision\", \"cloud_run_job\")"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "model_cost" {
  # Alert policies on postly.* need the metric to exist; see var.app_metric_alerts.
  count = var.app_metric_alerts ? 1 : 0

  project               = var.project_id
  display_name          = "Postly ${var.env_name}: model cost spike"
  combiner              = "OR"
  notification_channels = local.channels
  documentation {
    content   = local.runbook["cost-spike"]
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "model spend above USD ${var.model_cost_hourly_usd} in 1h"
    condition_threshold {
      filter          = "metric.type=\"${local.workload}/postly.model.cost_usd\" AND resource.type=\"generic_task\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.model_cost_hourly_usd
      duration        = "0s"
      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "model_validation" {
  # Alert policies on postly.* need the metric to exist; see var.app_metric_alerts.
  count = var.app_metric_alerts ? 1 : 0

  project               = var.project_id
  display_name          = "Postly ${var.env_name}: model validation failures"
  combiner              = "OR"
  notification_channels = local.channels
  documentation {
    content   = local.runbook["model-validation-failures"]
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "at least 5 invalid model outputs in 30 min"
    condition_threshold {
      filter          = "metric.type=\"${local.workload}/postly.model.calls.count\" AND metric.label.outcome=\"invalid\" AND resource.type=\"generic_task\""
      comparison      = "COMPARISON_GT"
      threshold_value = 4
      duration        = "0s"
      aggregations {
        alignment_period     = "1800s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.task"]
      }
    }
  }
}

resource "google_monitoring_alert_policy" "sql_connections" {
  project               = var.project_id
  display_name          = "Postly ${var.env_name}: Cloud SQL connections near max_connections"
  combiner              = "OR"
  notification_channels = local.channels
  documentation {
    content   = local.runbook["cloud-sql-connections-near-max"]
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "connections above 80% of ${var.sql_max_connections}"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${var.sql_instance}\""
      comparison      = "COMPARISON_GT"
      threshold_value = floor(var.sql_max_connections * 0.8)
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "error_budget" {
  project               = var.project_id
  display_name          = "Postly ${var.env_name}: web error budget burning"
  combiner              = "OR"
  notification_channels = local.channels
  documentation {
    content   = local.runbook["error-budget-burn"]
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "burn rate above 10x over 1h"
    condition_threshold {
      filter          = "select_slo_burn_rate(\"${google_monitoring_slo.web_availability.name}\", \"3600s\")"
      comparison      = "COMPARISON_GT"
      threshold_value = 10
      duration        = "0s"
    }
  }
}
