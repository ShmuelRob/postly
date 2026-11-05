# Log-based metrics (docs/observability.md, "Log-based metrics"), built from the structured log lines of
# WP-47: `message` is a fixed event name, `logging.googleapis.com/labels` becomes `labels.*` (businessId,
# jobName, process). The WP-48 metrics carry no business id, so the per-business view and the events
# that only a log line records come from here.

locals {
  postly_logs = "((resource.type=\"cloud_run_revision\" AND resource.labels.service_name=~\"^postly-${var.env_name}-\") OR (resource.type=\"cloud_run_job\" AND resource.labels.job_name=~\"^postly-${var.env_name}-\"))"
}

# Every log line that names a business, by event and severity: the per-business dashboard.
resource "google_logging_metric" "business_events" {
  project = var.project_id
  name    = "postly-${var.env_name}-business-events"
  filter  = "${local.postly_logs} AND labels.businessId:*"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key        = "business_id"
      value_type = "STRING"
    }
    labels {
      key        = "event"
      value_type = "STRING"
    }
    labels {
      key        = "severity"
      value_type = "STRING"
    }
  }
  label_extractors = {
    business_id = "EXTRACT(labels.businessId)"
    event       = "EXTRACT(jsonPayload.message)"
    severity    = "EXTRACT(severity)"
  }
}

# Non-2xx responses on the webhook routes (/webhooks/messaging, /webhooks/payment), from the Cloud Run
# request log, by route.
resource "google_logging_metric" "webhook_errors" {
  project = var.project_id
  name    = "postly-${var.env_name}-webhook-errors"
  filter  = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.web_service}\" AND log_id(\"run.googleapis.com/requests\") AND httpRequest.requestUrl:\"/webhooks/\" AND (httpRequest.status<200 OR httpRequest.status>=300)"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key        = "route"
      value_type = "STRING"
    }
  }
  label_extractors = {
    route = "REGEXP_EXTRACT(httpRequest.requestUrl, \"(/webhooks/[a-z]+)\")"
  }
}

# A business's publishing channel was found disconnected (log line `channel disconnected`, businessId).
resource "google_logging_metric" "channel_disconnected" {
  project = var.project_id
  name    = "postly-${var.env_name}-channel-disconnected"
  filter  = "${local.postly_logs} AND jsonPayload.message=\"channel disconnected\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key        = "business_id"
      value_type = "STRING"
    }
  }
  label_extractors = {
    business_id = "EXTRACT(labels.businessId)"
  }
}
