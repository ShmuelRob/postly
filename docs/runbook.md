# Runbook

One entry per alert. Each says what the alert means, how to check it, what to do, and when to escalate or pause publishing. The alerts are defined in `infra/modules/monitoring/main.tf`; each alert's documentation links to its entry here by the anchor under the heading. Logging fields are described in observability.md (WP-47).

Placeholders: `ENV` is `dev`, `stage` or `prod`; `PROJECT` is that environment's GCP project; `REGION` is `me-west1` unless Terraform says otherwise. Services are named `postly-ENV-web`, `postly-ENV-worker` and `postly-ENV-console`; the jobs include `postly-ENV-migrate`.

## Common tools

**Logs.** Cloud Console: Logging, Logs Explorer, pick `PROJECT`. Every process writes one JSON line per event with `severity`, `message`, and the correlation ids as labels (`requestId`, `businessId`, `messageId`, `jobId`, `jobName`, `process`). Filter by id, for example `labels.businessId="<id>"` in the `logging.googleapis.com/labels` field. Logs carry ids only, never customer text or phone numbers, so find a customer by id from the console, not from a log.

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="postly-ENV-web" AND severity>=ERROR' --project PROJECT --freshness 1h --limit 50 --format json
```

**Service state.** Cloud Console: Cloud Run, pick the service, then Revisions and Logs.

```bash
gcloud run services describe postly-ENV-web --region REGION --project PROJECT
gcloud run revisions list --service postly-ENV-web --region REGION --project PROJECT
```

**The console and the pause flags.** The deployed console has internal-only ingress and no sign-in ([security.md](security.md#console-exposure)). Reach it through the bastion path described there: `gcloud compute ssh --tunnel-through-iap` to a VM in the VPC, then call the console's internal URL with `Authorization: Bearer $(gcloud auth print-identity-token)`. If no bastion exists yet, the deployed console is unreachable; ask the human.

- **Pause all publishing:** `POST /console/api/system/pause` with `{"by": "<your name>", "reason": "<why>"}`, or the pause control on the console home page. Resume with the same control. The flag is the `system_control` row (`publishing_paused`, `paused_reason`, `paused_at`, `paused_by`).
- **Pause one business:** `POST /console/api/businesses/<id>/pause`; resume with `/resume` (needs a verified channel connection).
- A pause defers work; it changes no post or publication state, and the publishing job re-checks the flags right before calling the provider ([state-machines.md](state-machines.md)). Pausing is always safe and reversible; prefer it to guessing.

**Escalation.** The on-call person is whoever receives the alert email. Escalate to the human (the project owner) when customer posts may be wrong, duplicated or lost, when data may be exposed, or when a fix needs a deploy, a Terraform apply, a migration or a secret change (agents and this runbook never deploy or apply).

## Web health check failing

**Alert:** "Postly ENV: web health check failing" (uptime check `postly-ENV-web-healthz`, `/healthz` over HTTPS every 60 s; fires after 5 minutes of failures).

**Means:** the public web service, which takes the WhatsApp and payment webhooks, is down or not answering. Inbound messages are missed or retried by the vendor while this lasts.

**Check:**
1. Cloud Console: Monitoring, Uptime checks, `postly-ENV-web-healthz`: which regions fail, and with what status.
2. `gcloud run services describe postly-ENV-web --region REGION --project PROJECT` and look at `Ready` and the latest revision.
3. Logs: `resource.type="cloud_run_revision" AND resource.labels.service_name="postly-ENV-web" AND severity>=WARNING`. Look for startup errors (a `message` about config or the database), or no lines at all.
4. Did a deploy just happen? `gcloud run revisions list` shows the time of the last revision.

**Do:**
- A bad revision after a deploy: roll back with the Deploy workflow's `workflow_dispatch` (redeploy an earlier image tag, from the environment's own branch), or `gcloud run services update-traffic postly-ENV-web --to-revisions <good-revision>=100 --region REGION --project PROJECT`.
- Startup failure on config or the database: check the Cloud SQL instance is up (see [Cloud SQL CPU or disk high](#cloud-sql-cpu-or-disk-high)) and that the secrets listed in [deployment.md](deployment.md) exist.
- Only the uptime check fails while Cloud Run shows healthy: check the host in the check still matches the service URL.

**Escalate / pause:** if down for more than 15 minutes, or a rollback does not bring it back, tell the human. Webhooks that arrived while it was down are retried by the vendors, so no pause is needed for the outage itself; pause publishing only if the worker or database is also in doubt.

## Web 5xx responses

**Alert:** "Postly ENV: web 5xx responses" (more than 5 server errors in 5 minutes on the web service).

**Means:** the web service is up but failing some requests: webhook handlers, the burst handler, or the database.

**Check:**
1. Cloud Console: Cloud Run, `postly-ENV-web`, Metrics, "Request count" by response code class.
2. Logs Explorer: `resource.type="cloud_run_revision" AND resource.labels.service_name="postly-ENV-web" AND severity>=ERROR`. Group by `jsonPayload.message`; take a `requestId` from a line and read all lines with that label to see the path.
3. If the lines mention the database, check [Cloud SQL CPU or disk high](#cloud-sql-cpu-or-disk-high) and the connection budget in [deployment.md](deployment.md).

**Do:** a single bad revision: roll back as above. One webhook route failing: check whether the vendor changed its payload (the signature and schema checks log a fixed message). Database connection errors: look for a worker or job holding connections; restart a service only with the human's agreement.

**Escalate / pause:** if the errors are in the approval or publishing paths, or you cannot explain them within 30 minutes, pause all publishing and tell the human. Plain 5xx on read paths needs no pause.

## Error log lines

**Alert:** "Postly ENV: error log lines" (more than 10 lines with `severity>=ERROR` or `jsonPayload.level="error"` in 10 minutes, from any web, worker or console service or job; log-based metric `postly-ENV-error-lines`).

**Means:** something is failing repeatedly in a process: pg-boss errors, a failed weekly tick, a failed publication run, a model call that keeps failing validation, a startup error.

**Check:**
1. Logs Explorer with the metric's filter: `(resource.type="cloud_run_revision" AND resource.labels.service_name=~"^postly-ENV-") OR (resource.type="cloud_run_job" AND resource.labels.job_name=~"^postly-ENV-")` plus `severity>=ERROR`.
2. Group by the `process` label and `jsonPayload.message`: which process, which message, since when. A `jobName` label names the failing job; a `businessId` label says whether one business or all are affected.
3. Open the console's items list for the same time window: failures that exhausted their retries become console items.

**Do:**
- One business: open its console item, fix or route it, and use the business pause if it keeps failing.
- A failed migration (`postly-ENV-migrate`): the database stayed at the previous migration and the rollout stopped; fix forward with a new PR, never edit the database by hand.
- Everything fails after a deploy: roll back.

**Escalate / pause:** pause all publishing if the errors come from the publishing job, or you see signs of wrong content (a factual-safeguard failure, an approval that does not match). Tell the human for anything touching approval, publishing, secrets or tenant isolation.

## Cloud SQL CPU or disk high

**Alert:** "Postly ENV: Cloud SQL CPU or disk high" (CPU above 80% for 10 minutes, or disk above 85% for 10 minutes).

**Means:** the database is under load or filling up. Slow queries cascade into 5xx, job retries and a growing backlog; a full disk stops writes.

**Check:**
1. Cloud Console: SQL, the instance, Overview and Query insights (CPU, top queries, connections).
2. `gcloud sql instances describe <instance> --project PROJECT --format="value(state,settings.dataDiskSizeGb,settings.tier)"`.
3. Statements slower than 1 second are logged: Logs Explorer `resource.type="cloudsql_database" AND textPayload:"duration:"`.
4. Disk: is it the pg-boss tables (the `pgboss` schema, a stuck backlog) or business data? The instance's storage chart shows the trend.

**Do:** a runaway query or retry loop: find its job in the logs and fix the cause in code. Disk: raise the disk size or tier in `infra/modules/cloud_sql` through a PR, applied by the human. Never turn on `log_statement` (it would log the role passwords, see [deployment.md](deployment.md)).

**Escalate / pause:** pause all publishing when disk is above 95% or the instance is unresponsive, then tell the human at once. Resizing is a Terraform change, so it is the human's call.

## Publishing failures

**Alert:** "publishing failure rate" (at least 3 failed publication runs in 1 hour and more than 20% of runs; log metrics `postly-ENV-publication-failed` and `postly-ENV-publication-finished`).

**Means:** the publishing job is failing to put approved posts live. Owners' approved posts are late or stuck in `retry_pending` or `failed`.

**Check:**
1. Logs Explorer: `resource.type="cloud_run_revision" AND resource.labels.service_name="postly-ENV-worker" AND severity>=ERROR`, then group by `jsonPayload.message`. The log-based metric's filter in `infra/modules/monitoring` names the exact failed-run message.
2. Narrow by the `businessId` label: one business (its channel or token) or all (the vendor or our code).
3. Console: the publications list, filtered to failed and retry-pending.

**Do:** one business: check its channel connection (see [Channel disconnected](#channel-disconnected)). All businesses: check the publishing vendor's status page and our recent deploy; roll back a bad revision. Retry from the console (`POST /console/api/publications/<id>/retry`) only after the cause is fixed. The retry still passes the approved-hash check; never work around it.

**Escalate / pause:** pause all publishing if posts publish wrongly, twice, or to the wrong business; tell the human at once. A plain vendor outage needs no pause, the retries cover it.

## Webhook errors

**Alert:** "webhook errors" (5 or more non-2xx responses on `/webhooks/*` in 10 minutes; log metric `postly-ENV-webhook-errors`, from Cloud Run request logs).

**Means:** the messaging or payment vendor is sending webhooks that we reject or fail. Owner messages or payment events may be dropped once the vendor stops retrying.

**Check:**
1. Logs Explorer: `resource.type="cloud_run_revision" AND resource.labels.service_name="postly-ENV-web" AND httpRequest.requestUrl=~"/webhooks/" AND httpRequest.status>=300`. Read `httpRequest.status` (401/403 point at a signature or secret, 400/422 at a payload change, 5xx at our code).
2. Take a `requestId` from the matching application lines and read the whole request.
3. Check the vendor dashboard for failed deliveries and its retry state.

**Do:** 401/403: the webhook secret in Secret Manager no longer matches the vendor's (the human rotates secrets). 400/422: the vendor changed its payload; fix the schema in a PR. 5xx: see [Web 5xx responses](#web-5xx-responses). After the fix, ask the vendor to redeliver failed events; messages are deduplicated by id.

**Escalate / pause:** tell the human for a secret mismatch. No pause needed unless approvals are involved (a missed approval tap only delays a post).

## Job queue stuck

**Alert:** "job queue stuck" (more than 50 queued jobs, or the oldest queued job older than 15 minutes, for 15 minutes; WP-48 queue metric, log metric `postly-ENV-queue-depth` until it merges). Anchor: `pgboss-backlog`.

<a id="pgboss-backlog"></a>

**Means:** pg-boss jobs (the publishing job, the weekly tick, drafts, deletion) are queued faster than the worker runs them, or not running at all.

**Check:**
1. Is the worker running? See [Worker not running](#worker-not-running).
2. Logs: `resource.labels.service_name="postly-ENV-worker"`, group by the `jobName` label; look for one job type failing or running very long.
3. Database: queue counts per state, as the admin through the bastion, `select name, state, count(*) from pgboss.job group by 1,2;` (read only). Also check [Cloud SQL CPU or disk high](#cloud-sql-cpu-or-disk-high).

**Do:** one failing job type: fix the cause and let pg-boss retry (3 retries). A slow worker: raise `worker_max_instances` in Terraform (human applies). Never delete rows from `pgboss` by hand.

**Escalate / pause:** pause all publishing if due publications are waiting more than 30 minutes past their schedule, so the backlog cannot flush stale posts all at once on recovery; tell the human.

## Worker not running

**Alert:** "worker not running" (worker instance count 0 for 10 minutes; `run.googleapis.com/container/instance_count`).

**Means:** nothing runs jobs: no publishing, no weekly tick, no drafts or deletion.

**Check:**
1. `gcloud run services describe postly-ENV-worker --region REGION --project PROJECT`: is the latest revision `Ready`, and is min instances at least 1?
2. Logs for the worker around its last start: `resource.labels.service_name="postly-ENV-worker" AND severity>=WARNING` (startup failures, a missing pg-boss login or secret).
3. Cloud Console: Cloud Run, `postly-ENV-worker`, Metrics, Instance count.

**Do:** bad revision: roll back as in [Web health check failing](#web-health-check-failing). Startup error on the database or secrets: see [deployment.md](deployment.md) and the migrate job's last run. Min instances 0 or a deleted service is a Terraform matter for the human.

**Escalate / pause:** tell the human if not back in 15 minutes. Publishing is already stopped, so a pause is only needed to avoid a flood when the worker returns after a long outage; check the oldest due publication first.

## Channel disconnected

**Alert:** "channel disconnected" (any channel disconnect logged in 10 minutes; log metric `postly-ENV-channel-disconnected`).

**Means:** a business's Instagram or Facebook (or WhatsApp) connection stopped verifying, so its posts cannot publish.

**Check:**
1. Logs Explorer: the metric's filter in `infra/modules/monitoring`; read the `businessId` label and the reason field.
2. Console: that business's page, channel connections and their status.

**Do:** the owner must reconnect: the agent sends them the reconnect link through the normal conversation flow (a console item exists for it). A business with no verified connection cannot be resumed, so it stays paused until reconnected. Many businesses at once points at the publishing vendor or an expired app token, not the owners.

**Escalate / pause:** pause the one business if posts keep failing; tell the human if more than one business disconnects or it looks like a vendor-wide token problem.

## Model cost spike

**Alert:** "model cost spike" (model cost above USD 5 in 1 hour, set per environment; log metric `postly-ENV-model-cost`, distribution of `costUsd`). Anchor: `cost-spike`.

<a id="cost-spike"></a>

**Means:** model calls are costing far more than normal: a retry loop, an oversized input, or a task moved to a pricier model.

**Check:**
1. Logs Explorer: the metric's filter; group by the task name and the `businessId` label; sum `costUsd`.
2. Console: model settings (`model_task_config`) for a recent change; the `model_run` records for the top task.
3. Compare with [Model validation failure spike](#model-validation-failures): validation retries multiply cost.

**Do:** one business or one task looping: pause that business, fix the cause, then resume. A bad model setting: change it in the console model settings.

**Escalate / pause:** pause all publishing is not needed; pause the offending business. Tell the human if the cost continues after the pause or exceeds the budget.

## Model validation failures

**Alert:** "model validation failure spike" (5 or more invalid model outputs in 30 minutes; log metric `postly-ENV-model-validation-failed`).

**Means:** model outputs fail their Zod schema. Retries are limited, then the item routes to the console, so owners wait.

**Check:**
1. Logs Explorer: the metric's filter; group by task and prompt version.
2. Console: items routed from the model layer; the `model_run` record shows input, prompt version and output for a sample.
3. Did a prompt or model setting change recently?

**Do:** roll back the prompt version or model setting; a provider-side model change needs a PR to the prompt or schema (customer-facing prompts need human review). Resolve routed items by hand from the console.

**Escalate / pause:** tell the human; nothing wrong can go live because validation blocks it, so no pause is needed.

## Cloud SQL connections near max

**Alert:** "Cloud SQL connections near max_connections" (more than 80% of `max_connections` in use for 10 minutes; `postgresql/num_backends`). Anchor: `cloud-sql-connections-near-max`.

<a id="cloud-sql-connections-near-max"></a>

**Means:** the processes are close to exhausting database connections; new requests and jobs will start to fail.

**Check:**
1. Cloud Console: SQL, the instance, Overview, Connections; compare with the connection budget in [deployment.md](deployment.md) (55 per process, plus the migrate job).
2. Did instance counts rise? `gcloud run services describe` for web and worker and check the max instances.
3. Look for connection errors in the logs: `severity>=ERROR AND jsonPayload.message:"connection"`.

**Do:** restart is not a fix. Lower the instance maximum or raise `max_connections`/tier in Terraform (human applies; Terraform already refuses a plan over budget). A leak shows as a count that climbs and never falls: roll back the revision.

**Escalate / pause:** pause all publishing if connection errors appear; tell the human.

## Error budget burn

**Alert:** "error budget burn" (99.5% 28-day web availability SLO, burn rate above 10x over 1 hour; SLO on Cloud Run `request_count`).

**Means:** the web service is failing enough requests to use up the month's error budget within days.

**Check:**
1. Cloud Console: Monitoring, Services, the web service's SLO, and its error budget chart.
2. Same as [Web 5xx responses](#web-5xx-responses): find the failing path and revision.

**Do:** fix or roll back the cause; freeze non-urgent deploys while the budget is low.

**Escalate / pause:** tell the human if the budget is more than half used. Pause as in [Web 5xx responses](#web-5xx-responses).
