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
