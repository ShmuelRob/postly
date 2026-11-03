# Deployment

How Postly runs on Google Cloud (WP-44), and what the human does before anything is deployed. Hebrew summary: [deployment.summary.he.md](deployment.summary.he.md).

Nothing here has been applied. Agents write and validate the deployment code only (`terraform init -backend=false`, `terraform validate`, `terraform fmt -check`, a local `docker compose` run). Creating cloud resources, spending money, and deploying wait for the human ([implementation-plan.md](implementation-plan.md#operating-mode), gate H8; [human-review-queue.md](human-review-queue.md) items 21 to 24).

## Architecture

```
GitHub Actions (manual, approval-guarded) ── WIF ──> deploy service account
        │ push image                          │ update job and services
        v                                     v
Artifact Registry ──image──> Cloud Run: web (Fastify)      public, 1 instance, webhooks + /healthz
                             Cloud Run: worker (pg-boss)   internal, 1 or 2 instances, /healthz only
                             Cloud Run job: migrate        runs before each rollout
                                     │ direct VPC egress (private ranges)
                                     v
                             Cloud SQL Postgres 17 (private IP only, TLS, backups + PITR)
Secret Manager: one secret per database login, the admin URL, vendor keys (values added by the human)
Cloud Storage: customer media bucket (private, versioned, lifecycle)
Cloud Monitoring: uptime check, web 5xx, error log lines, Cloud SQL CPU and disk
```

- **One image** (`Dockerfile`): Node 26 on Debian slim, Playwright Chromium with its system libraries, and sharp. `tsc -p tsconfig.build.json` compiles `src/` to `dist/` (tests, fixtures and the simulator contract suites are excluded; `playground/` and `test/` never enter the build context, see `.dockerignore`). It runs as the non-root `node` user. The command picks the process: `web`, `worker`, or `migrate` (`src/main.ts`).
- **web** serves the messaging webhook, the billing webhook when configured, and `/healthz`, and runs the inbound sweep (technical-design.md, Onboarding flow). It is the only public service.
- **worker** runs pg-boss jobs. Its first job is the weekly tick: `WeeklyUpdates.tick` every hour on the hour (UTC cron `0 * * * *`), on a pg-boss queue with the `singleton` policy, so with several worker instances only one tick is active at a time and each hourly job is created once (`src/worker.ts`). A failed tick fails the job and pg-boss retries it (3 retries). The worker serves only `/healthz`, because Cloud Run services need a port to probe.
- **migrate** is a Cloud Run job (`src/db/provision.ts`), run as the Cloud SQL admin user before each rollout. It applies the Drizzle migrations in `drizzle/`, which create one login per role of [database-schema.md](database-schema.md#least-privilege); sets each login's password from Secret Manager; creates the pg-boss login `app_jobs` and its schema `pgboss`, owned by that login; and lets pg-boss create its tables as `app_jobs`. Terraform never creates database roles.
- **Providers.** Until the vendor adapters land (WP-41), the image runs only on the simulators (`POSTLY_PROVIDERS=simulators`; any other value refuses to start) with in-process media storage. A staging deploy before WP-41 therefore reaches no vendor and keeps no media across restarts. WP-41 adds the vendor adapters, the Cloud Storage media adapter and the reading of the vendor secrets.

### Configuration

| Variable | Where from | Meaning |
| --- | --- | --- |
| `POSTLY_PROVIDERS` | Terraform | `simulators` until WP-41 |
| `DATABASE_URL` | Terraform | `postgres://<private ip>:5432/postly?sslmode=require`, with no user: each login's URL is built from it |
| `DB_PASSWORD_<LOGIN>` | Secret Manager `postly-<env>-db-password-<login>` | One per login in `ALL_LOGINS` (`src/db/index.ts`): the 13 role logins and `app_jobs` |
| `MIGRATE_ADMIN_URL` | Secret Manager `postly-<env>-db-admin-url` | The admin user's full URL; read only by the migrate job's service account |
| `PUBLIC_BASE_URL`, `BUSINESS_NUMBER` | Terraform variables | The web service's HTTPS URL and Postly's WhatsApp number |
| `MEDIA_BUCKET` | Terraform | The media bucket name, for WP-41 |
| `PORT` | Cloud Run | 8080 |

### Terraform

`infra/modules/stack` is one environment; `infra/environments/staging` and `infra/environments/prod` call it with their sizes. Submodules: `network` (VPC, subnet for direct VPC egress, private services access for Cloud SQL), `artifact_registry`, `service_accounts`, `secrets` (names and reader bindings, never values), `cloud_sql`, `storage`, `cloud_run` (a service or a job), `monitoring`. `stack/github_oidc.tf` sets up Workload Identity Federation for the deploy workflow. The remote state backend (`gcs`) is commented out in each environment for the human to fill in. Real values go in a git-ignored `terraform.tfvars` (copy `terraform.tfvars.example`).

| | staging | prod |
| --- | --- | --- |
| Cloud SQL | `db-g1-small`, zonal, no deletion protection | `db-custom-2-7680`, regional (HA), deletion protection |
| Worker instances | at most 1 | at most 2 |
| Media: old object versions kept | 7 days | 30 days |
| Media: to Coldline after | 90 days | 180 days |

The media lifecycle ages are provisional until the human sets the media retention policy (technical-design.md, Still required). Region defaults to `me-west1` (Tel Aviv).

### IAM (least privilege)

| Account | Gets | Never gets |
| --- | --- | --- |
| `postly-<env>-web` | Cloud SQL client, log, metric and trace writer; the login password secrets and vendor secrets; object user on the media bucket; image pull | the admin URL |
| `postly-<env>-worker` | the same as web | the admin URL |
| `postly-<env>-migrate` | Cloud SQL client, log and metric writer; the login password secrets and the admin URL; image pull | the bucket, vendor secrets |
| `postly-<env>-deploy` | `run.developer`, act as the three runtime accounts, image push on this repository | any secret, the bucket, the database |

Every secret and bucket binding is on the resource, not on the project. Only GitHub Actions jobs of the named repository running in the GitHub environment of the same name (`staging` or `prod`) can act as the deploy account.

### Single web instance (review queue item 14)

The inbound burst buffer lives in the web process's memory. The sweep (`App.start()`) covers a restart and a failed handler, but across two web instances a slow burst can still be handed over twice. Until bursts are durable (a pg-boss job or a database claim keyed by business and sender), the web service runs exactly one instance: `web_max_instances` must be 1, and Terraform refuses another value. The claim was not built in WP-44 because it changes the messaging module and needs a migration, while WP-32 is working on the core files; it stays open as item 14.

## CI

- `.github/workflows/ci.yml` (unchanged): `npm run check` on every PR and on main.
- `.github/workflows/infra.yml`: on every PR and on main, builds the image (never pushed), checks it runs as non-root with no test or playground code, starts the local stack on the simulators with `docker compose` and checks `/healthz` and the singleton weekly schedule, and runs `terraform fmt -check` and `terraform validate` for both environments. It never authenticates to Google Cloud.
- `.github/workflows/deploy.yml`: manual only (`workflow_dispatch`), one environment per run, gated by the GitHub environment's required reviewers. It authenticates through Workload Identity Federation (no key file), builds and pushes the image tagged with the commit, runs the migration job and waits for it, rolls out the worker and then the web, and checks `/healthz`. It never runs Terraform. Without the environment variables below it stops at its first step.

## Local run

`docker compose up --build` starts Postgres, runs the migrate job, then web (port 8080) and worker, all on the simulators with local-only passwords. Postgres listens on host port 55432.

## What the human does

All of this costs money or creates cloud resources, so agents never do it.

1. **GCP project and billing.** Create a project per environment (or one for staging first), link billing, and enable the APIs: `run`, `sqladmin`, `compute`, `servicenetworking`, `secretmanager`, `artifactregistry`, `iam`, `iamcredentials`, `sts`, `monitoring`, `logging`, `cloudresourcemanager`.
2. **State bucket.** Create a versioned GCS bucket for Terraform state, then uncomment the `backend "gcs"` block in `infra/environments/<env>/main.tf` with its name.
3. **Variables.** Copy `terraform.tfvars.example` to `terraform.tfvars` and fill in the project, the test WhatsApp number (staging) or the real one (prod), the repository, and the alert email. `public_base_url` can be a placeholder for the first apply, then the web service's `run.app` URL or a custom domain.
4. **First apply.** `terraform init`, `terraform plan`, review it, `terraform apply`. The services start from the tag `bootstrap`, which does not exist yet, so the first apply reports them unhealthy until the first deploy; that is expected. Alternatively push a first image by hand before applying.
5. **Secrets.** Add a version to every secret in the `secret_ids` output: a strong random password for each `db-password-*`; for `db-admin-url`, set the Cloud SQL `postgres` user's password (`gcloud sql users set-password postgres --instance ...`) and store `postgres://postgres:<password>@<private ip>:5432/postly?sslmode=require`. Vendor secrets stay empty until WP-41.
6. **GitHub.** Create the environments `staging` and `prod` with required reviewers, and set on each the variables `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WORKLOAD_IDENTITY_PROVIDER` (the `workload_identity_provider` output) and `GCP_DEPLOY_SERVICE_ACCOUNT` (the `deploy_service_account` output).
7. **Vendor accounts** (WP-41, later): WhatsApp (Twilio or 360dialog), publishing (Zernio or Ayrshare), Google AI, and the payment provider; test accounts and test keys on staging.
8. **Console sign-in.** The console answers only loopback requests (review queue item 16), so it is unreachable on Cloud Run until the team's sign-in is decided (for example IAP).
9. **First deploy.** Run the Deploy workflow for `staging` and approve it. WP-44 is done when staging runs the end-to-end suite with test accounts, which needs WP-41.

## Migrations and rollback

- **Order.** Every deploy runs the migration job before rolling out new code, so a migration must keep the previous release working (expand, then contract in a later release): add columns and tables first, drop them only after no running release reads them. A migration that cannot be applied that way needs a planned maintenance window.
- **Review.** Migrations are generated with `npm run db:generate` and reviewed by the human before merge (CLAUDE.md, gate H4).
- **Failure.** The migration job runs with no retry. Drizzle applies each migration in a transaction, so a failed migration leaves the database at the previous one, and the workflow stops before any rollout.
- **Code rollback.** Roll the services back to the previous revision: `gcloud run services update-traffic postly-<env>-web --to-revisions <previous>=100` (and the same for the worker), or rerun the Deploy workflow on the previous commit. This is safe because the previous release works with the newer schema (expand first).
- **Data rollback.** Restore with Cloud SQL point-in-time recovery to a new instance, check it, then point `DATABASE_URL` at it with a Terraform change. Never restore over the running instance.
