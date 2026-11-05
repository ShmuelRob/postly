# The three dashboards (docs/observability.md, "Dashboards"): service overview, product flow, and a
# per-business view filtered by the business_id variable. Every environment gets the same three.
# Each chart is a line chart from one filter: { title, filter, aligner, reducer, group_by }.

locals {
  run_service = "resource.type=\"cloud_run_revision\" AND resource.label.service_name=starts_with(\"postly-${var.env_name}-\")"
  web_service = "resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${var.web_service}\""
  sql_db      = "resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${var.sql_instance}\""
  user_metric = "logging.googleapis.com/user"

  service_charts = [
    { title = "Web requests per second by response class", filter = "metric.type=\"run.googleapis.com/request_count\" AND ${local.web_service}", aligner = "ALIGN_RATE", reducer = "REDUCE_SUM", group_by = ["metric.label.response_code_class"] },
    { title = "Web latency p95 (ms)", filter = "metric.type=\"run.googleapis.com/request_latencies\" AND ${local.web_service}", aligner = "ALIGN_DELTA", reducer = "REDUCE_PERCENTILE_95", group_by = [] },
    { title = "Web 5xx per second", filter = "metric.type=\"run.googleapis.com/request_count\" AND ${local.web_service} AND metric.label.response_code_class=\"5xx\"", aligner = "ALIGN_RATE", reducer = "REDUCE_SUM", group_by = [] },
    { title = "Instances by service", filter = "metric.type=\"run.googleapis.com/container/instance_count\" AND ${local.run_service}", aligner = "ALIGN_MAX", reducer = "REDUCE_SUM", group_by = ["resource.label.service_name"] },
    { title = "Cloud SQL CPU utilization", filter = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" AND ${local.sql_db}", aligner = "ALIGN_MEAN", reducer = "REDUCE_MEAN", group_by = [] },
    { title = "Cloud SQL memory utilization", filter = "metric.type=\"cloudsql.googleapis.com/database/memory/utilization\" AND ${local.sql_db}", aligner = "ALIGN_MEAN", reducer = "REDUCE_MEAN", group_by = [] },
    { title = "Cloud SQL connections (max_connections ${var.sql_max_connections})", filter = "metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\" AND ${local.sql_db}", aligner = "ALIGN_MEAN", reducer = "REDUCE_SUM", group_by = [] },
    { title = "Cloud SQL disk utilization", filter = "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\" AND ${local.sql_db}", aligner = "ALIGN_MEAN", reducer = "REDUCE_MEAN", group_by = [] },
    { title = "Error log lines", filter = "metric.type=\"${local.user_metric}/${google_logging_metric.errors.name}\"", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group_by = [] },
    { title = "Webhook errors by route", filter = "metric.type=\"${local.user_metric}/${google_logging_metric.webhook_errors.name}\"", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group_by = ["metric.label.route"] },
  ]

  product_charts = [
    { title = "Messages by direction and outcome", filter = "metric.type=\"${local.workload}/postly.messages.count\"", aligner = "ALIGN_DELTA", reducer = "REDUCE_SUM", group_by = ["metric.label.direction", "metric.label.outcome"] },
    { title = "Drafts by outcome", filter = "metric.type=\"${local.workload}/postly.drafts.count\"", aligner = "ALIGN_DELTA", reducer = "REDUCE_SUM", group_by = ["metric.label.outcome"] },
    { title = "Approvals by outcome and reason", filter = "metric.type=\"${local.workload}/postly.approvals.count\"", aligner = "ALIGN_DELTA", reducer = "REDUCE_SUM", group_by = ["metric.label.outcome", "metric.label.reason"] },
    { title = "Publications by outcome and network", filter = "metric.type=\"${local.workload}/postly.publications.count\"", aligner = "ALIGN_DELTA", reducer = "REDUCE_SUM", group_by = ["metric.label.outcome", "metric.label.network"] },
    { title = "Model cost (USD) by task", filter = "metric.type=\"${local.workload}/postly.model.cost_usd\"", aligner = "ALIGN_DELTA", reducer = "REDUCE_SUM", group_by = ["metric.label.task"] },
    { title = "Model latency p95 (ms) by task", filter = "metric.type=\"${local.workload}/postly.model.latency\"", aligner = "ALIGN_DELTA", reducer = "REDUCE_PERCENTILE_95", group_by = ["metric.label.task"] },
    { title = "Model calls by task and outcome", filter = "metric.type=\"${local.workload}/postly.model.calls.count\"", aligner = "ALIGN_DELTA", reducer = "REDUCE_SUM", group_by = ["metric.label.task", "metric.label.outcome"] },
    { title = "Queue depth by queue and state", filter = "metric.type=\"${local.workload}/postly.queue.depth\"", aligner = "ALIGN_MAX", reducer = "REDUCE_MAX", group_by = ["metric.label.queue", "metric.label.state"] },
    { title = "Job failures by job", filter = "metric.type=\"${local.workload}/postly.jobs.failures.count\"", aligner = "ALIGN_DELTA", reducer = "REDUCE_SUM", group_by = ["metric.label.job"] },
  ]

  business_charts = [
    { title = "Log events by event", filter = "metric.type=\"${local.user_metric}/${google_logging_metric.business_events.name}\"", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group_by = ["metric.label.event"] },
    { title = "Warnings and errors by event", filter = "metric.type=\"${local.user_metric}/${google_logging_metric.business_events.name}\" AND metric.label.severity=monitoring.regex.full_match(\"WARNING|ERROR\")", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group_by = ["metric.label.event", "metric.label.severity"] },
    { title = "Channel disconnects", filter = "metric.type=\"${local.user_metric}/${google_logging_metric.channel_disconnected.name}\"", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group_by = ["metric.label.business_id"] },
  ]
}

locals {
  # Two charts per row, each half the 48-column mosaic.
  tiles = {
    for name, charts in {
      service  = local.service_charts
      product  = local.product_charts
      business = local.business_charts
      } : name => [for i, c in charts : {
        xPos   = (i % 2) * 24
        yPos   = floor(i / 2) * 16
        width  = 24
        height = 16
        widget = {
          title = c.title
          xyChart = {
            dataSets = [{
              plotType = "LINE"
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = c.filter
                  aggregation = {
                    alignmentPeriod    = "300s"
                    perSeriesAligner   = c.aligner
                    crossSeriesReducer = c.reducer
                    groupByFields      = c.group_by
                  }
                }
              }
            }]
          }
        }
    }]
  }
}

resource "google_monitoring_dashboard" "service" {
  project = var.project_id
  dashboard_json = jsonencode({
    displayName  = "Postly ${var.env_name}: service overview"
    mosaicLayout = { columns = 48, tiles = local.tiles.service }
  })
}

resource "google_monitoring_dashboard" "product" {
  project = var.project_id
  dashboard_json = jsonencode({
    displayName  = "Postly ${var.env_name}: product flow"
    mosaicLayout = { columns = 48, tiles = local.tiles.product }
  })
}

# One dashboard for every business: enter a business id in the business_id filter at the top. The
# filter applies to every chart whose metric has the business_id label (the log-based metrics).
resource "google_monitoring_dashboard" "business" {
  project = var.project_id
  dashboard_json = jsonencode({
    displayName  = "Postly ${var.env_name}: per business"
    mosaicLayout = { columns = 48, tiles = local.tiles.business }
    dashboardFilters = [{
      filterType       = "METRIC_LABEL"
      labelKey         = "business_id"
      templateVariable = "business_id"
      stringValue      = ""
    }]
  })
}
