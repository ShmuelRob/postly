# Observability

Logs, metrics, traces, dashboards and alerts for the web, worker and console processes and the jobs they run (T14: WP-47 to WP-50). This document covers logging (WP-47); metrics and tracing (WP-48), dashboards and alerts (WP-49) and the runbook (WP-50) extend it.

## Logging (WP-47)

**One logger.** Every process logs through `src/shared/logger.ts`. No other code writes to the console; `src/shared/logger.test.ts` fails on a `console.*` call anywhere else in `src/`. Fastify's own logger stays off.

**Format.** One JSON object per line on stdout, in the structured form Google Cloud Logging reads on Cloud Run:

| Field | Value |
| --- | --- |
| `severity` | `DEBUG`, `INFO`, `WARNING` or `ERROR` |
| `message` | A fixed, short English description of the event (`publication run failed`), never built from data |
| `time` | ISO 8601 |
| `logging.googleapis.com/trace` | `projects/<GOOGLE_CLOUD_PROJECT>/traces/<trace id>`, when the request carried `X-Cloud-Trace-Context` (or `traceparent`) and the project is known |
| `logging.googleapis.com/labels` | The correlation ids of the current context: `requestId`, `businessId`, `messageId`, `jobId`, `jobName`, and `process` (`web`, `worker`, `console`, `migrate`) |
| other keys | The fields the call passed (ids, counts, status, a reason, the error text) |

**Correlation ids.** An `AsyncLocalStorage` context carries the ids, so a log line deep in a module gets them without passing them along. `withLogContext(fields, fn)` adds fields for everything `fn` runs, nested contexts add to their parent. The web server opens a context per request (`requestId` from Fastify, the trace from the header); each pg-boss and in-memory job runs in a context with `jobId` and `jobName`; the inbound burst handler adds `businessId` and the `messageId` of the burst's first message. Explicit fields on a call win over the context.

**No customer content, phone numbers or secrets (H4, H8).** Logs carry ids, never what the owner wrote, a caption, a draft, a phone number, a token, a password or a connection string. The logger enforces this in code, not only by convention:

- A field whose name names content or a secret (`text`, `body`, `caption`, `content`, `message`, `phone`, `from`, `to`, `token`, `secret`, `password`, `key`, `authorization`, `cookie`, `url`) is replaced by `[redacted]`. Ids (`*Id`) are kept.
- In every string value, including error text, phone numbers (7 or more digits, with `+`, spaces or dashes), credentials in URLs (`scheme://user:pass@`), `Bearer` tokens and long key-like strings (32 or more letters, digits, `-` or `_` in a row, other than a UUID) are replaced by `[redacted]`.
- String values are cut at 500 characters; objects and arrays are not logged, only scalars.

`src/shared/logger.test.ts` feeds customer text, phone numbers and secrets through every field and fails if any reaches a line. Error messages from vendors may still quote content in words the patterns do not catch, so error text is logged only at the boundary that handles the failure, cut short, and never with the request or response body.

**Retention.** The `_Default` bucket keeps logs 7 days in `dev` and 30 in `stage` and `prod` ([deployment.md](deployment.md)).

## Dashboards and alerts (WP-49)

`infra/modules/monitoring` defines everything below for each environment; `dev`, `stage` and `prod` get the same dashboards and alerts. Each environment is its own Google Cloud project, so a metric type alone selects the environment. CI runs `terraform fmt -check` and `terraform validate` on every root; no agent runs `plan` with credentials or `apply` (H8). Alerts go to the `alert_email` channel. Every alert's documentation field links to its entry in `runbook.md` (WP-50), by the anchor in the table below.

**Sources.** Product metrics are WP-48's OpenTelemetry metrics (`workload.googleapis.com/postly.*`, listed in WP-48's section). They carry no business id, so the per-business view and events that only a log line records come from log-based metrics on the WP-47 lines: `message` is a fixed event name, and the context labels become `labels.businessId`, `labels.jobName` and `labels.process`. Platform signals are the built-in Cloud Run and Cloud SQL metrics.

### Log-based metrics

| Metric | Counts | Labels |
| --- | --- | --- |
| `postly-<env>-error-lines` | Lines with severity `ERROR` from any Postly service or job | none |
| `postly-<env>-business-events` | Every line that names a business | `business_id`, `event` (the `message`), `severity` |
| `postly-<env>-webhook-errors` | Non-2xx responses on `/webhooks/*`, from the Cloud Run request log | `route` |
| `postly-<env>-channel-disconnected` | Lines `channel disconnected` | `business_id` |

The line `channel disconnected` (severity `WARNING`, with `businessId` and `network`) is the contract for the channel-disconnected alert; the publishing module logs it when a publish or health check finds a business's channel disconnected. Until that line exists the alert never fires. `business_id` is a label on purpose: Postly has a few hundred businesses in Phase 1, well within Cloud Monitoring's label limits; past a few thousand, move the per-business view to Log Analytics.

### Dashboards

- **Service overview:** web requests by response class, web p95 latency, web 5xx, instances per service, Cloud SQL CPU, memory, connections (with `max_connections`) and disk, error log lines, webhook errors.
- **Product flow:** messages in and out, drafts by outcome, approvals by outcome, publications by status and network, model cost, p95 latency and calls by task and outcome, queue depth, job failures, pool connections.
- **Per business:** one dashboard with a `business_id` filter at the top: the business's log events by event, its warnings and errors, and channel disconnects. No customer content reaches it, only ids and event names.

### Alerts

| Alert | Fires when | Signal | Runbook anchor |
| --- | --- | --- | --- |
| Web health check failing | `/healthz` fails for 5 min | uptime check | `web-health-check-failing` |
| Web 5xx responses | more than 5 in 5 min | `run.googleapis.com/request_count` | `web-5xx-responses` |
| Error log lines | more than 10 in 10 min | `postly-<env>-error-lines` | `error-log-lines` |
| Cloud SQL CPU or disk high | CPU above 80% or disk above 85% for 10 min | Cloud SQL | `cloud-sql-cpu-or-disk-high` |
| Publishing failure rate | in 1 h, over 20% of publication runs failed and at least 3 failed | `postly.publications.count` | `publishing-failures` |
| Webhook errors | at least 5 non-2xx on one webhook route in 10 min | `postly-<env>-webhook-errors` | `webhook-errors` |
| Job queue stuck | a queue holds more than 50 jobs for 15 min | `postly.queue.depth` | `pgboss-backlog` |
| Worker not running | no worker instance, or no instance data, for 10 min | `run.googleapis.com/container/instance_count` | `worker-not-running` |
| Publishing channel disconnected | any `channel disconnected` line in 10 min | `postly-<env>-channel-disconnected` | `channel-disconnected` |
| Model cost spike | model spend above `model_cost_hourly_usd` (USD 5 by default) in 1 h | `postly.model.cost_usd` | `cost-spike` |
| Model validation failures | at least 5 invalid outputs for one task in 30 min | `postly.model.calls.count`, `outcome=validation_failed` | `model-validation-failures` |
| Cloud SQL connections near max | connections above 80% of `max_connections` for 10 min | `cloudsql.googleapis.com/database/postgresql/num_backends` | `cloud-sql-connections-near-max` |
| Error budget burning | the web SLO burns its budget more than 10 times too fast over 1 h | SLO burn rate | `error-budget-burn` |

### Error budget

One SLO: 99.5% of web requests over a rolling 28 days are not 5xx (`google_monitoring_slo` on a custom service). That leaves about 3.6 hours of full outage a month. A burn rate of 10 over an hour spends about 1.5% of the month's budget in that hour; the alert pages then, before the budget is gone.
