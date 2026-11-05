# Deployment

How Postly runs on Google Cloud (WP-44), and what the human does before anything is deployed. Hebrew summary: [deployment.summary.he.md](deployment.summary.he.md).

Nothing here has been applied. Agents write and validate the deployment code only (`terraform init -backend=false`, `terraform validate`, `terraform fmt -check`, a local `docker compose` run). Creating cloud resources, spending money, and deploying wait for the human ([implementation-plan.md](implementation-plan.md#operating-mode), gate H8; [human-review-queue.md](human-review-queue.md) items 21 to 24).

## Architecture

```
GitHub Actions (on push; stage/prod approval-guarded) ── WIF ──> deploy service account
        │ push image                          │ update job and services
        v                                     v
Artifact Registry ──image──> Cloud Run: web (Fastify)      public, 1 instance, webhooks + /healthz
                             Cloud Run: worker (pg-boss)   internal, 1 or 2 instances, /healthz only
                             Cloud Run: console            internal only, no public invoker (docs/security.md)
                             Cloud Run job: migrate        runs before each rollout
                                     │ direct VPC egress (private ranges)
                                     v
                             Cloud SQL Postgres 17 (private IP only, TLS, backups + PITR)
Secret Manager: one secret per database login, the admin URL, vendor keys (values added by the human)
Cloud Storage: customer media bucket (private, versioned, lifecycle)
Cloud Monitoring: uptime check, web 5xx, error log lines, Cloud SQL CPU and disk
```

- **One image** (`Dockerfile`): Node 26 on Debian slim, Playwright Chromium with its system libraries, and sharp. `tsc -p tsconfig.build.json` compiles `src/` to `dist/` (tests, fixtures and the simulator contract suites are excluded; `playground/` and `test/` never enter the build context, see `.dockerignore`). It runs as the non-root `node` user. The command picks the process: `web`, `worker`, `console`, or `migrate` (`src/main.ts`).
- **web** serves the messaging webhook, the billing webhook when configured, and `/healthz`, and runs the inbound sweep (technical-design.md, Onboarding flow). It is the only public service.
- **console** serves only the internal console and `/healthz`, as its own service with internal-only ingress and no public invoker, because ingress is set per service ([security.md](security.md#console-exposure)). It is not a sign-in.
- **worker** runs pg-boss jobs. Its first job is the weekly tick: `WeeklyUpdates.tick` every hour on the hour (UTC cron `0 * * * *`), on a pg-boss queue with the `singleton` policy, so with several worker instances only one tick is active at a time and each hourly job is created once (`src/worker.ts`). A failed tick fails the job and pg-boss retries it (3 retries). The worker serves only `/healthz`, because Cloud Run services need a port to probe.
- **migrate** is a Cloud Run job (`src/db/provision.ts`), run as the Cloud SQL admin user before each rollout. It applies the Drizzle migrations in `drizzle/`, which create one login per role of [database-schema.md](database-schema.md#least-privilege); sets each login's password from Secret Manager; creates the pg-boss login `app_jobs` and its schema `pgboss`, owned by that login; and lets pg-boss create its tables as `app_jobs`. Terraform never creates database roles. **Keep `log_statement` off.** The `ALTER ROLE ... PASSWORD` statements carry the login passwords in clear text, so Cloud SQL's `log_statement` flag must stay `none` (Terraform sets it explicitly in `infra/modules/cloud_sql`); never turn on `ddl`, `mod` or `all`, or pgAudit statement logging, on this instance. `log_min_duration_statement` stays at 1 s for slow queries; the password statements run in milliseconds.
- **Providers.** Until the vendor adapters land (WP-41), the image runs only on the simulators (`POSTLY_PROVIDERS=simulators`; any other value refuses to start) with in-process media storage. A stage deploy before WP-41 therefore reaches no vendor and keeps no media across restarts. WP-41 adds the vendor adapters, the Cloud Storage media adapter and the reading of the vendor secrets.

### Configuration

| Variable | Where from | Meaning |
| --- | --- | --- |
| `POSTLY_ENV` | Terraform, docker-compose | Required, with no default: `dev`, `stage` or `prod` on Cloud Run, `local` or `test` elsewhere. A process without it refuses to start, so a deployed service never falls back to the public webhook secret |
| `POSTLY_PROVIDERS` | Terraform | `simulators` until WP-41 |
| `MESSAGING_WEBHOOK_SECRET` | Secret Manager `postly-<env>-messaging-webhook-secret` | Verifies inbound messaging webhooks. In `dev`, `stage` and `prod` the processes refuse to start when it is missing or equals the simulator default, which is public in the repository (`src/config.ts`); `local` and `test` fall back to that default |
| `DATABASE_URL` | Terraform | `postgres://<private ip>:5432/postly?sslmode=require`, with no user: each login's URL is built from it |
| `DB_PASSWORD_<LOGIN>` | Secret Manager `postly-<env>-db-password-<login>` | One per login in `ALL_LOGINS` (`src/db/index.ts`): the 13 role logins and `app_jobs` |
| `MIGRATE_ADMIN_URL` | Secret Manager `postly-<env>-db-admin-url` | The admin user's full URL; read only by the migrate job's service account |
| `PUBLIC_BASE_URL`, `BUSINESS_NUMBER` | Terraform variables | The web service's HTTPS URL and Postly's WhatsApp number |
| `MEDIA_BUCKET` | Terraform | The media bucket name, for WP-41 |
| `PORT` | Cloud Run | 8080 |

### Terraform

`infra/modules/stack` is one environment; `infra/environments/dev`, `infra/environments/stage` and `infra/environments/prod` call it with their sizes, and each also calls `infra/modules/github_environment` for its GitHub environment. Submodules: `network` (VPC, subnet for direct VPC egress, private services access for Cloud SQL), `artifact_registry`, `service_accounts`, `secrets` (names and reader bindings), `cloud_sql`, `storage`, `cloud_run` (a service or a job), `monitoring`. `stack/github_oidc.tf` sets up Workload Identity Federation for the deploy workflow.

Terraform does everything that needs no human decision:

- **APIs.** `stack/apis.tf` enables every API the stack uses (`google_project_service`, never disabled on destroy).
- **Generated secrets.** `stack/secret_values.tf` generates a random password for every `db-password-*` and for `messaging-webhook-secret`, sets the Cloud SQL `postgres` user's password from another one, and writes `db-admin-url` from it and the instance's private IP. Vendor secrets get no version until WP-41.
- **GitHub environments.** `modules/github_environment` creates the environment (`dev`, `stage` or `prod`) with a deployment branch policy that allows only its own branch (`dev`, `stage`, or `main` for prod), required reviewers on `stage` and `prod` (`deploy_reviewers`, default the repository owner), and the variables `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_DEPLOY_SERVICE_ACCOUNT`. It also creates the environment's branch from `main` (`dev` and `stage`; prod uses `main` itself) and protects it: changes only through a pull request with the `check` job passing. The `github` provider reads its token from the `GITHUB_TOKEN` environment variable, never from tfvars.
- **State.** `infra/bootstrap` (local state) creates a private, versioned bucket `<project_id>-tfstate`; each environment's `backend "gcs"` block is filled in except for the bucket, passed at `terraform init`.
- **Defaults.** `public_base_url` defaults to the web service's `run.app` URL, `region` to `me-west1`, `github_repository` to `ShmuelRob/postly`. `terraform.tfvars` (git-ignored, from `terraform.tfvars.example`) needs only `project_id`, `business_number` and `alert_email`.

**Secrets in the state.** The generated values are in the Terraform state. That is acceptable only because the state bucket is private (uniform access, public access prevention), versioned, and readable only by the project's owners and editors; never grant anyone else access to it, and never use local state for an environment.

| | dev | stage | prod |
| --- | --- | --- | --- |
| Cloud SQL | `db-custom-2-7680` (2 vCPU, 7.5 GB, `max_connections` 400), zonal, no deletion protection | the same, no deletion protection | the same, deletion protection |
| Cloud SQL replicas and HA | none (zonal, no read replicas) | none | none |
| Cloud SQL backups kept | 3 | 14 | 14 |
| Web | 1 vCPU, 2 GiB, exactly 1 instance | the same | the same |
| Worker | 2 vCPU, 4 GiB (Chromium rendering), at most 1 instance | the same, at most 1 | the same, at most 2 |
| Media: old object versions kept | 7 days | 7 days | 7 days |
| Media: to Coldline after | 180 days | 180 days | 180 days |
| Log retention (`_Default` bucket) | 7 days | GCP default (30) | GCP default (30) |
| Branch | `dev` | `stage` | `main` |
| Deploy | automatic on push | on push, after a required reviewer | on push, after a required reviewer |

**Sizing (review queue items 21, 23).** Every environment is medium-low, not the smallest, in `me-west1` (Tel Aviv), with no replicas and no HA; dev is sized like stage and prod so a release behaves the same in each. The numbers stay inside GCP's limits, checked on 2026-11-04:

- *Cloud Run:* 1 vCPU allows up to 4 GiB, 2 vCPU up to 8 GiB; above 4 GiB needs at least 2 vCPU. Web (1 vCPU, 2 GiB) and worker (2 vCPU, 4 GiB) are within both.
- *Cloud SQL (Enterprise edition, custom tier):* 1 vCPU or an even count, 0.9 to 6.5 GB of memory per vCPU in multiples of 256 MB, at least 3.75 GB. `db-custom-2-7680` is 3.75 GB per vCPU. Shared-core tiers (`db-f1-micro`, `db-g1-small`) have no SLA and too few connections. Postgres' default `max_connections` for 7.5 GB is 400; the module sets it explicitly so the check below holds.
- *Connection budget:* each process opens at most 3 connections per login (15 logins, `createDatabase`) plus pg-boss' pool of 10, so 55 per process; the migrate job adds 11 and Cloud SQL reserves a few for its own use (budgeted as 10). Terraform refuses a plan where `(web max + worker max) × 55 + 11 + 10` exceeds `max_connections`: prod needs `3 × 55 + 21 = 186` of 400.

**Branches and promotion.** Each environment has its own branch: `dev` deploys to dev, `stage` to stage, `main` to prod. Feature pull requests target `dev`. Promotion is a pull request `dev` → `stage`, then `stage` → `main`, merged with a merge commit (not squashed) so the branches keep one history. Every other pull request is squash-merged. A branch takes newer changes by merging the base branch into it, never by rebase or force-push. All three branches are protected: changes only through a pull request with `check` passing. A push to a branch (that is, a merged pull request) deploys it to its environment.

**Environments.** `dev` is an always-on cloud environment on the simulators (later test accounts) that agents and humans may deploy freely: the sizes above, one web and one worker instance, no HA, short log retention. It has the same safety rules as `stage`: test accounts and test keys only, never real customer channels or data, and `messaging-webhook-secret` is required. `stage` mirrors prod's setup on test accounts and is where releases are checked before prod. `prod` is the only environment with real customers.

**Media lifecycle and retention.** The Coldline age (180 days) is longer than the 30-day data retention after cancellation (technical-design.md), so the bucket never moves a live file before the data-deletion job decides on it, and it is past Coldline's 90-day minimum storage charge. The old-version age works the other way: the bucket is versioned, and `days_since_noncurrent_time` removes only versions already overwritten or deleted, so it is kept short (7 days) and media the data-deletion job removes on day 30 is gone for good by about day 37. Only `tmp/` scratch files from rendering are deleted after 1 day. A Terraform `check` in `infra/modules/storage` flags a Coldline age at or below its `retention_days` (30). The ages stay provisional until the human sets the media retention policy (technical-design.md, Still required). Region defaults to `me-west1` (Tel Aviv).

### IAM (least privilege)

| Account | Gets | Never gets |
| --- | --- | --- |
| `postly-<env>-web` | Cloud SQL client, log, metric and trace writer, Vertex AI user (`roles/aiplatform.user`, project-level, for Gemini); the login password secrets and vendor secrets; object user on the media bucket; image pull | the admin URL |
| `postly-<env>-worker` | the same as web | the admin URL |
| `postly-<env>-migrate` | Cloud SQL client, log and metric writer; the login password secrets and the admin URL; image pull | the bucket, vendor secrets |
| `postly-<env>-deploy` | `run.developer`, act as the three runtime accounts, image push on this repository | a direct grant on any secret, the bucket, or the database |

Every secret and bucket binding is on the resource, not on the project. Only GitHub Actions jobs of the named repository running in the GitHub environment of the same name (`dev`, `stage` or `prod`) and on that environment's branch (`dev`, `stage` or `main`) can act as the deploy account.

**The deploy account can still reach data, indirectly.** It pushes any image and runs it as the migrate job (or as web or worker), and those accounts read the admin URL, the login passwords and the media bucket. So whoever can run the Deploy workflow can run code with database admin access; the missing direct grants do not stop that. The real gate is the GitHub environment: required reviewers on `stage` and `prod`, a deployment branch policy that allows only each environment's own branch, and branch protection that lets code reach those branches only through a reviewed pull request with `check` passing. `dev` has no required reviewer on purpose: anything merged to `dev` gets admin access to dev's database, which holds only test data. Terraform sets both (`modules/github_environment`); keep the reviewer list short.

**Who merges and who approves deploys (accepted for now, review queue item 31).** Every agent runs `gh` as the human's account, which is the only required reviewer and a repository admin, so GitHub alone cannot stop an agent from approving a stage or prod deploy or merging a promotion pull request. The gate for agents is procedural: only the reviewer session merges pull requests, including the promotion pull requests (`dev` → `stage`, `stage` → `main`); every other agent opens pull requests and never merges. No agent ever approves a stage or prod deployment in the GitHub environment; only the human does. A later hardening option is a separate GitHub identity for agents with neither admin nor deployment-approval rights.

### Single web instance (review queue item 14)

The inbound burst buffer lives in the web process's memory. The sweep (`App.start()`) covers a restart and a failed handler, but across two web instances a slow burst can still be handed over twice. Until bursts are durable (a pg-boss job or a database claim keyed by business and sender), the web service runs exactly one instance: `web_max_instances` must be 1, and Terraform refuses another value. The claim was not built in WP-44 because it changes the messaging module and needs a migration, while WP-32 is working on the core files; it stays open as item 14.

## CI

- `.github/workflows/ci.yml`: `npm run check` on every PR and on every push to `dev`, `stage` and `main`.
- `.github/workflows/infra.yml`: on every PR and on every push to `dev`, `stage` and `main`, builds the image (never pushed), checks it runs as non-root with no test or playground code, starts the local stack on the simulators with `docker compose` and checks `/healthz` and the singleton weekly schedule, and runs `terraform fmt -check` and `terraform validate` for the three environments and `infra/bootstrap`. It never authenticates to Google Cloud.
- `.github/workflows/deploy.yml` (CD): runs on every push to `dev`, `stage` or `main` and deploys to the matching environment (dev, stage, prod); stage and prod wait for the environment's required reviewer, which is the approval gate. `workflow_dispatch` redeploys an existing image tag (a rollback), run from the environment's own branch. Every action is pinned by commit SHA, here and in `infra.yml`. It authenticates through Workload Identity Federation (no key file), builds the image once per run and pushes it tagged with the commit, runs the migration job and waits for it, rolls out the worker and then the web, and checks `/healthz`. It never runs Terraform. The job is skipped (not failed) until Terraform has set the repository variable `POSTLY_DEPLOY_<ENV>` (`DEV`, `STAGE`, `PROD`) for that environment; a job-level `if` cannot read the environment's own variables such as `GCP_PROJECT_ID`, so this flag stands in for the `vars.GCP_PROJECT_ID != ''` check. If the environment variables are still missing, it stops at its first step.

## Local run

`docker compose up --build` starts Postgres, runs the migrate job, then web (port 8080) and worker, all on the simulators with local-only passwords. Postgres listens on host port 55432.

## What the human does

All of this costs money or creates cloud resources, so agents never do it. Per environment (one GCP project each, or start with dev):

1. **GCP project and billing.** Create the project and link billing. Each environment needs its own project: dev's 7-day `_Default` log retention applies to the whole project.
2. **Sign in.** `gcloud auth application-default login`, and `export GITHUB_TOKEN=<token>` (a fine-grained token with Administration, Contents, Environments and Variables write on the repository; Contents is needed to create the `dev` and `stage` branches).
3. **State bucket.** In `infra/bootstrap`: `terraform init`, `terraform apply -var project_id=<project>`.
4. **Environment.** In `infra/environments/<env>`: copy `terraform.tfvars.example` to `terraform.tfvars` and fill in its three values, then `terraform init -backend-config="bucket=<project>-tfstate"`, `terraform plan`, review it, `terraform apply`. The services and the migrate job start from the image tag `bootstrap`, which does not exist yet, and Cloud Run cannot create a service from a missing image or pass the startup probe before the migrate job has created the logins, so a single first apply fails on the services. Apply in three passes instead: the image repository, then push an image tagged `bootstrap`; then the database, secrets and migrate job, and run the job; then everything else. [deploy-dev-guide.md](deploy-dev-guide.md) has the exact commands.
5. **First deploy.** The dev apply creates the `dev` branch and the stage apply the `stage` branch; the next push to each branch deploys it (stage and prod wait for a reviewer), or run the Deploy workflow by hand from that branch.

**Dev first.** Applying only bootstrap and `infra/environments/dev` works on its own: the dev root creates the `dev` branch from `main`, its protection, the `dev` GitHub environment with its variables and `POSTLY_DEPLOY_DEV`, and nothing of stage or prod. The `main` branch protection, the `stage` branch and their environments are created only by the prod and stage roots, so until those run, pushes to `stage` or `main` skip the deploy job cleanly (no `POSTLY_DEPLOY_STAGE` or `POSTLY_DEPLOY_PROD`). The roots share no GitHub resource (each manages its own branch, environment and flag, and only reads the repository), so a later stage or prod apply does not fight dev. Each root's state sits under its own prefix (`postly/dev`, `postly/stage`, `postly/prod`) in `<project>-tfstate`; with one project per environment, run bootstrap once in each project.

```bash
export GITHUB_TOKEN=<token>
gcloud auth application-default login
terraform -chdir=infra/bootstrap init
terraform -chdir=infra/bootstrap apply -var project_id=<dev-project>
# first apply: three passes, see deploy-dev-guide.md
cp infra/environments/dev/terraform.tfvars.example infra/environments/dev/terraform.tfvars   # fill in the three values
terraform -chdir=infra/environments/dev init -backend-config="bucket=<dev-project>-tfstate"
terraform -chdir=infra/environments/dev plan -out=dev.tfplan
terraform -chdir=infra/environments/dev apply dev.tfplan
```

Later: **vendor accounts** (WP-41: WhatsApp, publishing, payments; test accounts and test keys on dev and stage) and their secret values, and the **console access path**: the console runs as its own internal-only service ([security.md](security.md#console-exposure)), reached from a bastion VM in the VPC over `gcloud compute ssh --tunnel-through-iap`; the bastion is not in Terraform yet, so the deployed console is unreachable until it is, and the team sign-in (D1) comes after. WP-44 is done when stage runs the end-to-end suite with test accounts, which needs WP-41.

Gemini needs no vendor account or key: Terraform enables `aiplatform.googleapis.com` and grants `roles/aiplatform.user` to the web and worker service accounts, which call Vertex AI with their own credentials (Application Default Credentials).

## Migrations and rollback

- **Order.** Every deploy runs the migration job before rolling out new code, so a migration must keep the previous release working (expand, then contract in a later release): add columns and tables first, drop them only after no running release reads them. A migration that cannot be applied that way needs a planned maintenance window.
- **Review.** Migrations are generated with `npm run db:generate` and reviewed by the human before merge (CLAUDE.md, gate H4).
- **Failure.** The migration job runs with no retry. Drizzle applies each migration in a transaction, so a failed migration leaves the database at the previous one, and the workflow stops before any rollout.
- **Code rollback.** Roll the services back to the previous revision: `gcloud run services update-traffic postly-<env>-web --to-revisions <previous>=100` (and the same for the worker), or run the Deploy workflow by hand with the previous image tag (its commit SHA). This is safe because the previous release works with the newer schema (expand first).
- **Data rollback.** Restore with Cloud SQL point-in-time recovery to a new instance, check it, then point `DATABASE_URL` at it with a Terraform change. Never restore over the running instance.
