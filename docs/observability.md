# Observability

Logs, metrics, traces, dashboards and alerts for the web, worker and console processes and the jobs they run (T14: WP-47 to WP-50). This document covers logging (WP-47), metrics, tracing and Error Reporting (WP-48); dashboards and alerts (WP-49) and the runbook (WP-50) extend it.

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

## Metrics (WP-48)

**One catalogue.** Every metric is declared once in `src/shared/telemetry.ts` (`METRICS`) with its kind, unit and the labels it may carry, and code records it only through `metrics.count` and `metrics.record`. The table below is that catalogue; `src/shared/telemetry.test.ts` checks the two match, so a change to one changes the other.

**Export.** The processes use the OpenTelemetry API. Deployed (`POSTLY_ENV` `dev`, `stage` or `prod`), `src/shared/telemetry-gcp.ts` exports metrics to Cloud Monitoring every 60 seconds with the Google Cloud exporter, so each metric's type is `workload.googleapis.com/<name>`, on the `generic_task` resource, whose `job` label is the process (`web`, `worker`, `console`), `namespace` the environment, and `task_id` the instance. Locally and in tests nothing is exported unless `TELEMETRY_EXPORT=log` is set, which writes each point as a `metric` log line every 10 seconds (the playground); tests read points from an in-memory reader.

| Metric | Kind (unit) | Labels | Recorded when |
| --- | --- | --- | --- |
| `postly.messages.count` | counter | `direction` (`in`, `out`), `kind` (`text`, `voice`, `image`, `button_reply`, `buttons`, `template`), `outcome` (`accepted`, `duplicate`, `unknown_number`, `sent`, `failed`) | An inbound message is received (once per provider message), or an outbound send returns or throws |
| `postly.drafts.count` | counter | `outcome` (`sent`, `asked`, `failed`) | A draft run of one post ends: sent to the owner, a question asked, or failed (the fact check failing every attempt is `failed`) |
| `postly.approvals.count` | counter | `outcome` (`approved`, `refused`), `reason` (`none` or an `ApprovalRefusal`: `not_a_button`, `not_approver`, `unknown_post`, `stale_version`, `wrong_state`, `handoff`, `duplicate`) | An approval tap is decided |
| `postly.publications.count` | counter | `outcome` (`published`, `already_published`, `retry_pending`, `failed`, `refused`, `deferred`), `network` (`instagram`, `facebook`, `none` when refused before load) | A publication run ends |
| `postly.model.calls.count` | counter | `task` (a model task name), `outcome` (`valid`, `invalid`, `provider_error`) | One model attempt ends (one per `model_run` row) |
| `postly.model.cost_usd` | counter (USD) | `task` | An attempt returns a cost |
| `postly.model.latency` | histogram (ms) | `task`, `outcome` | One model attempt ends |
| `postly.jobs.duration` | histogram (ms) | `job` (the queue name), `outcome` (`ok`, `failed`) | A pg-boss or in-memory job handler returns or throws |
| `postly.jobs.failures.count` | counter | `job` | A job handler throws |
| `postly.queue.depth` | gauge | `queue`, `state` (`queued`, `active`) | Read from pg-boss every export, in the worker |

**Database connections** use Cloud SQL's own metric, `cloudsql.googleapis.com/database/postgresql/num_backends` (with `database`), not an app metric: the driver does not expose pool counts, and the server's count covers every process.

**No customer content in a label (H4, H8).** Every label value is either from a fixed list in the catalogue or a code constant (a job or queue name, a model task name); `metrics.count` replaces any other value with `other` and drops a label the metric does not declare. There is no `business_id` label: it would make one series per business, and per-business views come from the logs, which carry `businessId`. A message's text, a caption, a phone number or an error text can never reach a metric.

## Tracing (WP-48)

**Cloud Trace through OpenTelemetry.** Deployed, `src/shared/telemetry-gcp.ts` registers a tracer provider with the Cloud Trace exporter, a batch span processor, and parent-based sampling at 10% (`TRACE_SAMPLE_RATIO`), and the `AsyncLocalStorage` context manager. Cloud Run's `traceparent` header is the parent of the request span, so one trace covers Cloud Run's own span and ours.

**Spans.** `withSpan(name, attributes, fn)` from `src/shared/telemetry.ts` is the only way code opens a span. The spans are: `http <method> <route>` per web and console request (the route pattern, never the URL), `job <name>` per job run, `model <task>` per model attempt, `draft post` per draft run, `publication run` per publication, and `inbound burst`. A span that throws gets status `ERROR` with the scrubbed error text and no exception event.

**No customer content in an attribute.** Only these attribute keys exist: `businessId`, `postId`, `publicationId`, `messageId`, `jobId`, `job`, `task`, `attempt`, `network`, `outcome`, `http.method`, `http.route`, `http.status_code`. `withSpan` drops any other key, and drops a string value that is not a UUID or a short code word (`[a-z0-9_./-]{1,64}`), so free text never reaches a span.

**Logs join traces.** Inside a span, the logger takes the trace and span ids from it (`logging.googleapis.com/trace`, `logging.googleapis.com/spanId`, `logging.googleapis.com/trace_sampled`), so a log line opens next to its trace.

## Error Reporting (WP-48)

Every `ERROR` log line is also an error event: the logger adds `@type: type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent` and `serviceContext` (`service` is the process, `version` is `K_REVISION` or `local`), so Cloud Error Reporting groups it with no client library. When a field is an `Error`, the line carries `stack_trace`: the error name, the scrubbed message, and the stack frames (file paths and line numbers only). There is no separate reporting call, so redaction stays in one place.

## Dashboards and alerts (WP-49)

`infra/modules/monitoring` defines everything below for each environment; `dev`, `stage` and `prod` get the same dashboards and alerts. Each environment is its own Google Cloud project, so a metric type alone selects the environment. CI runs `terraform fmt -check` and `terraform validate` on every root; no agent runs `plan` with credentials or `apply` (H8). Alerts go to the `alert_email` channel. Every alert's documentation field links to its entry in `runbook.md` (WP-50), by the anchor in the table below.

**Sources.** Product metrics are WP-48's OpenTelemetry metrics (`workload.googleapis.com/postly.*`, listed in "Metrics (WP-48)"). They carry no business id, so the per-business view and events that only a log line records come from log-based metrics on the WP-47 lines: `message` is a fixed event name, and the context labels become `labels.businessId`, `labels.jobName` and `labels.process`. Platform signals are the built-in Cloud Run and Cloud SQL metrics.

### Log-based metrics

| Metric | Counts | Labels |
| --- | --- | --- |
| `postly-<env>-error-lines` | Lines with severity `ERROR` from any Postly service or job | none |
| `postly-<env>-business-events` | Every line that names a business | `business_id`, `event` (the `message`), `severity` |
| `postly-<env>-webhook-errors` | Non-2xx responses on `/webhooks/*`, from the Cloud Run request log | `route` |
| `postly-<env>-channel-disconnected` | Lines `channel disconnected` | `business_id` |

The line `channel disconnected` (severity `WARNING`, with `businessId`, `channelId`, `network` and `providerStatus`) is the contract for the channel-disconnected alert; the publishing module's daily channel health check logs it once, when a verified channel becomes `disconnected` (`logChannelDisconnected` in `src/modules/publishing/channels.ts`, tested in `channels-log.test.ts`). `business_id` is a label on purpose: Postly has a few hundred businesses in Phase 1, well within Cloud Monitoring's label limits; past a few thousand, move the per-business view to Log Analytics.

### Dashboards

- **Service overview:** web requests by response class, web p95 latency, web 5xx, instances per service, Cloud SQL CPU, memory, connections (with `max_connections`) and disk, error log lines, webhook errors.
- **Product flow:** messages in and out, drafts by outcome, approvals by outcome, publications by status and network, model cost, p95 latency and calls by task and outcome, queue depth by state, job failures. Database connections are on the service overview (Cloud SQL `num_backends`); there is no app pool metric.
- **Per business:** one dashboard with a `business_id` filter at the top: the business's log events by event, its warnings and errors, and channel disconnects. No customer content reaches it, only ids and event names.

### Alerts

| Alert | Fires when | Signal | Runbook anchor |
| --- | --- | --- | --- |
| Web health check failing | `/health` fails for 5 min | uptime check | `web-health-check-failing` |
| Web 5xx responses | more than 5 in 5 min | `run.googleapis.com/request_count` | `web-5xx-responses` |
| Error log lines | more than 10 in 10 min | `postly-<env>-error-lines` | `error-log-lines` |
| Cloud SQL CPU or disk high | CPU above 80% or disk above 85% for 10 min | Cloud SQL | `cloud-sql-cpu-or-disk-high` |
| Publishing failure rate | in 1 h, over 20% of finished publication runs (`published` or `failed`) failed and at least 3 failed | `postly.publications.count`, `outcome=failed` | `publishing-failures` |
| Webhook errors | at least 5 non-2xx on one webhook route in 10 min | `postly-<env>-webhook-errors` | `webhook-errors` |
| Job queue stuck | a queue holds more than 50 queued jobs for 15 min | `postly.queue.depth`, `state=queued` | `pgboss-backlog` |
| Worker not running | no worker instance, or no instance data, for 10 min | `run.googleapis.com/container/instance_count` | `worker-not-running` |
| Publishing channel disconnected | any `channel disconnected` line in 10 min | `postly-<env>-channel-disconnected` | `channel-disconnected` |
| Model cost spike | model spend above `model_cost_hourly_usd` (USD 5 by default) in 1 h | `postly.model.cost_usd` | `cost-spike` |
| Model validation failures | at least 5 invalid outputs for one task in 30 min | `postly.model.calls.count`, `outcome=invalid` | `model-validation-failures` |
| Cloud SQL connections near max | connections above 80% of `max_connections` for 10 min | `cloudsql.googleapis.com/database/postgresql/num_backends` | `cloud-sql-connections-near-max` |
| Error budget burning | the web SLO burns its budget more than 10 times too fast over 1 h | SLO burn rate | `error-budget-burn` |

### Error budget

One SLO: 99.5% of web requests over a rolling 28 days are not 5xx (`google_monitoring_slo` on a custom service). That leaves about 3.6 hours of full outage a month. A burn rate of 10 over an hour spends about 1.5% of the month's budget in that hour; the alert pages then, before the budget is gone.
