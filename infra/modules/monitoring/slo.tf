# The web availability SLO (docs/observability.md, "Error budget"): 99.5% of web requests over a rolling
# 28 days are not 5xx. The error-budget alert in alerts.tf watches its burn rate.

resource "google_monitoring_custom_service" "web" {
  project      = var.project_id
  service_id   = "postly-${var.env_name}-web"
  display_name = "Postly ${var.env_name} web"
}

resource "google_monitoring_slo" "web_availability" {
  project             = var.project_id
  service             = google_monitoring_custom_service.web.service_id
  slo_id              = "web-availability"
  display_name        = "Postly ${var.env_name}: 99.5% of web requests are not 5xx (28 days)"
  goal                = 0.995
  rolling_period_days = 28
  request_based_sli {
    good_total_ratio {
      total_service_filter = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${var.web_service}\""
      bad_service_filter   = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${var.web_service}\" AND metric.label.response_code_class=\"5xx\""
    }
  }
}
