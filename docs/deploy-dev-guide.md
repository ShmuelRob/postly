# Deploying dev: a first-time guide

A numbered, copy-paste walk-through for the human who deploys the **dev** environment for the first time, on Windows. It follows [deployment.md](deployment.md) (the design and the rules) and the code on `main`: `infra/bootstrap`, `infra/environments/dev`, `infra/modules/*`, `.github/workflows/deploy.yml` and `src/config.ts`. Hebrew summary: [deploy-dev-guide.summary.he.md](deploy-dev-guide.summary.he.md).

Agents never run these steps (gate H8). Nothing here has been tried against a real GCP project yet, so read each plan before you apply it.

Commands are for **PowerShell** unless a block says otherwise. Run them from the repository root (`C:\dev\postly` or your clone).

## 1. Install the tools

| Tool | Version | Install (PowerShell, as yourself) |
| --- | --- | --- |
| Google Cloud CLI (`gcloud`) | any recent | `winget install Google.CloudSDK` |
| Terraform | **1.13.x** (CI uses `1.13.x`; the roots need `>= 1.9`) | `winget install Hashicorp.Terraform`, then check `terraform version` |
| GitHub CLI (`gh`) | any recent | `winget install GitHub.cli` |
| Docker Desktop | any recent, running | `winget install Docker.DockerDesktop` (needed once, in step 4b) |

Open a **new** PowerShell window after installing so the tools are on `PATH`.

The lock files (`infra/bootstrap/.terraform.lock.hcl`, `infra/environments/dev/.terraform.lock.hcl`) pin the providers: `hashicorp/google` 7.46.2, `hashicorp/random` 3.9.1, `integrations/github` 6.13.0. `terraform init` downloads exactly those; do not run `init -upgrade`.

### Log in

```powershell
gcloud auth login
gcloud auth application-default login
gh auth login
```

`gcloud auth login` is for the `gcloud` commands; `application-default login` is what Terraform uses. Both open a browser.

### A GitHub token for Terraform

Terraform's `github` provider reads `GITHUB_TOKEN` from the environment (never from tfvars). Create a **fine-grained personal access token** at GitHub → Settings → Developer settings → Fine-grained tokens:

- Resource owner: `ShmuelRob`; repository access: only `ShmuelRob/postly`.
- Repository permissions, **Read and write**: Administration (branch protection), Contents (creating the `dev` branch), Environments, Variables. Metadata: read (added automatically).
- A short expiry (7 days) is enough.

Then, in the same PowerShell window you will run Terraform from:

```powershell
$env:GITHUB_TOKEN = "<paste the token>"
```

It lasts only for that window. Do not save it in a file in the repository.

## 2. Create the GCP project

Pick a globally unique id, for example `postly-dev-<your initials>`.

```powershell
$PROJECT = "postly-dev-xyz"
gcloud projects create $PROJECT --name "Postly dev"
gcloud billing accounts list
gcloud billing projects link $PROJECT --billing-account <ACCOUNT_ID from the list>
gcloud config set project $PROJECT
gcloud auth application-default set-quota-project $PROJECT
```

Dev needs its own project: the 7-day log retention dev sets applies to the whole project.

**Set a budget alert** (Console → Billing → Budgets & alerts, for example 400 USD a month with emails at 50%, 90%, 100%). It only warns; it never stops spending.

### What dev costs

Roughly **280 to 330 USD a month**, almost all of it fixed, because dev is sized like prod and keeps instances running. Estimated from GCP list prices (us-central1, checked from memory of the public price lists, not a quote) with a 10 to 15% uplift for `me-west1`; confirm in the [GCP pricing calculator](https://cloud.google.com/products/calculator) before you apply:

| Item | Size in Terraform | Math | Per month |
| --- | --- | --- | --- |
| Cloud SQL | `db-custom-2-7680`, Enterprise, zonal, 10 GB SSD, 3 backups | 2 vCPU × ~0.041 + 7.5 GB × ~0.007 ≈ 0.135 USD/h × 730 h, plus disk and backups | ~100 to 120 |
| Cloud Run web | 1 vCPU, 2 GiB, 1 instance always on, CPU always allocated | (1 × 0.000018 + 2 × 0.000002) USD/s × 2.63 M s | ~58 to 65 |
| Cloud Run worker | 2 vCPU, 4 GiB, 1 instance always on, CPU always allocated | (2 × 0.000018 + 4 × 0.000002) USD/s × 2.63 M s | ~115 to 130 |
| Cloud Run console | scales to zero, CPU only during requests | used rarely | ~0 |
| Console load balancer (IAP sign-in) | one global forwarding rule, created only once `console_iap_client_id` is set | ~0.025 USD/h × 730 h | ~18 |
| Secret Manager, Artifact Registry, logs (7 days), monitoring, VPC | small | | ~5 to 10 |

The worker is the biggest line. Gemini calls (Vertex AI) are billed per use and are near zero on the simulators.

## 3. Bootstrap: the state bucket

This creates a private, versioned bucket `<project>-tfstate` that holds dev's Terraform state (local state for this root only).

```powershell
terraform -chdir=infra/bootstrap init
terraform -chdir=infra/bootstrap apply -var "project_id=$PROJECT"
```

Type `yes`. It takes about a minute and creates two things: the Storage API enablement and the bucket. Keep `infra/bootstrap/terraform.tfstate` (git-ignored) somewhere safe; it only describes the bucket.

## 4. Apply dev

### 4a. Fill in `terraform.tfvars`

```powershell
Copy-Item infra/environments/dev/terraform.tfvars.example infra/environments/dev/terraform.tfvars
notepad infra/environments/dev/terraform.tfvars
```

| Value | What to put | Where it comes from |
| --- | --- | --- |
| `project_id` | `postly-dev-xyz` | the project from step 2 |
| `business_number` | a made-up number in `+` format, for example `+15550000001` | **You do not need a real WhatsApp number.** Dev runs only on the simulators, so this is just a label (any non-empty string passes `src/config.ts`). Replace it with a real test number only when WP-41 connects WhatsApp |
| `alert_email` | your email | where the alerts in step 7 go |

Leave the rest out: `region` defaults to `me-west1`, `public_base_url` to the web service's `run.app` URL, `github_repository` to `ShmuelRob/postly`. The file is git-ignored.

### 4b. Init, then apply in three passes

```powershell
terraform -chdir=infra/environments/dev init -backend-config="bucket=$PROJECT-tfstate"
```

**Why three passes.** The Cloud Run services and the migrate job start from the image tag `bootstrap` (`infra/modules/stack`, `image_tag`), and the CD workflow can update a service only after Terraform created it. A Cloud Run service cannot be created from an image that does not exist, and the web and worker are created with one instance that must pass its `/healthz` startup probe against a database that has no logins yet. So: create the image repository, push a `bootstrap` image, create and run the migrate job, then apply the rest. (This differs from what [deployment.md](deployment.md#what-the-human-does) said before this guide: a single apply would fail on the services, not just show them unhealthy.)

**Pass 1: the image repository.**

```powershell
terraform -chdir=infra/environments/dev plan -target "module.postly.module.registry" -out dev-1.tfplan
terraform -chdir=infra/environments/dev apply dev-1.tfplan
```

Then build and push the image tagged `bootstrap` (Docker Desktop running):

```powershell
gcloud auth configure-docker me-west1-docker.pkg.dev --quiet
docker build -t "me-west1-docker.pkg.dev/$PROJECT/postly-dev/postly:bootstrap" .
docker push "me-west1-docker.pkg.dev/$PROJECT/postly-dev/postly:bootstrap"
```

The build takes 5 to 10 minutes the first time (Chromium).

**Pass 2: the database and the migrate job.**

```powershell
terraform -chdir=infra/environments/dev plan -target "module.postly.module.migrate" -target "module.postly.module.secrets" -target "module.postly.google_artifact_registry_repository_iam_member.pull" -out dev-2.tfplan
terraform -chdir=infra/environments/dev apply dev-2.tfplan
gcloud run jobs execute postly-dev-migrate --region me-west1 --wait
```

This pass creates the network, Cloud SQL, the secrets and their generated values, and the job. **Cloud SQL takes 10 to 20 minutes**, and private services access a few more. The job run takes 1 to 2 minutes and must end `succeeded`.

**Pass 3: everything else.**

```powershell
terraform -chdir=infra/environments/dev plan -out dev.tfplan
terraform -chdir=infra/environments/dev apply dev.tfplan
```

Read the plan before applying. 5 to 10 minutes. Terraform warns that `-target` was used in the earlier passes; that is expected. From now on, plain `plan` and `apply` are the normal commands.

### What the plan creates

- **APIs** (never disabled on destroy): Cloud Run, Cloud SQL Admin, Compute, Service Networking, Secret Manager, Artifact Registry, IAM, IAM Credentials, STS, Monitoring, Logging, Cloud Resource Manager, Storage, Vertex AI.
- **Network:** a VPC, a subnet for direct VPC egress, private services access for Cloud SQL.
- **Cloud SQL** `postly-dev-…`: Postgres 17, private IP only, TLS only, backups and point-in-time recovery, no deletion protection.
- **Secrets:** one per database login, the admin URL, the messaging webhook secret (all generated), and the vendor secrets (empty until WP-41).
- **Service accounts** `postly-dev-web`, `-worker`, `-migrate`, `-deploy`, with the grants in [deployment.md](deployment.md#iam-least-privilege).
- **Artifact Registry** `postly-dev`, the **media bucket**, **Cloud Run** services `postly-dev-web` (public), `postly-dev-worker` and `postly-dev-console` (internal only), and the job `postly-dev-migrate`.
- **Workload Identity Federation** for the GitHub deploy workflow (no key file).
- **Monitoring:** the uptime check and four alert policies (step 7), and the 7-day `_Default` log bucket.
- **GitHub** (step 5).

## 5. What appears in GitHub

Check at `https://github.com/ShmuelRob/postly`:

- **Branch `dev`**, created from `main` (Code → Branches).
- **Environment `dev`** (Settings → Environments): no required reviewer, deployment branches limited to `dev`, and environment variables `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`.
- **Repository variable `POSTLY_DEPLOY_DEV = true`** (Settings → Secrets and variables → Actions → Variables). This is what turns the Deploy job on for `dev`.
- **Branch protection on `dev`** (Settings → Branches): pull request required (0 approvals), status check `check` required, admins included, no deletion. You can no longer push to `dev` directly.

```powershell
gh api repos/ShmuelRob/postly/environments/dev --jq ".name"
gh variable list --repo ShmuelRob/postly
gh variable list --repo ShmuelRob/postly --env dev
```

## 6. The first deploy

The Deploy workflow (`.github/workflows/deploy.yml`) runs on every push to `dev`, which with protection means every **merged pull request into `dev`**. For the first one, open a pull request from `main` into `dev` (they are equal right after the apply, so make it carry the next change, or use the manual run below):

```powershell
gh pr create --repo ShmuelRob/postly --base dev --head main --title "First dev deploy" --body "Deploy main to dev"
```

Merge it once `check` passes. Or run Deploy by hand on an image that already exists, such as the `bootstrap` one:

```powershell
gh workflow run Deploy --repo ShmuelRob/postly --ref dev -f image_tag=bootstrap
gh run watch --repo ShmuelRob/postly
```

What the job does: authenticates through Workload Identity Federation; on a push, builds the image and pushes it tagged with the commit SHA; **runs the migration job** `postly-dev-migrate` and waits (a failed migration stops the run before any rollout, and the database stays on the previous migration); rolls out the worker, the console, then the web; and calls the web's `/healthz`. About **10 to 15 minutes** for a push (most of it the image build), 3 to 5 for a manual redeploy.

## 7. What you'll see

**Cloud Run URLs.**

```powershell
terraform -chdir=infra/environments/dev output -json postly
gcloud run services list --region me-west1
```

The public one is `postly-dev-web`, at `https://postly-dev-web-<hash>.me-west1.run.app` (output `web_url`). Worker and console have run.app URLs too, but their ingress refuses requests from the internet; the console is reached only through its load balancer.

**`/healthz`.**

```powershell
curl.exe -s "$(gcloud run services describe postly-dev-web --region me-west1 --format 'value(status.url)')/healthz"
```

returns `{"ok":true}`. That is all a browser on the web URL shows: dev has no public page.

**The internal console.** It is the `postly-dev-console` service, reached through an HTTPS load balancer where you sign in with your Google account (IAP; [security.md](security.md#console-exposure)). Its own run.app URL refuses requests from the internet. Terraform builds the load balancer only after a one-time manual OAuth setup, so until you do it the console is unreachable (the safe default) and costs nothing. When you want it:

1. Do the OAuth consent screen (External), the OAuth client (Web application, with the IAP redirect URI), the client secret and the IAP service agent, as in [deployment.md](deployment.md#console-sign-in-one-time-steps).
2. Add to `infra/environments/dev/terraform.tfvars`:

   ```hcl
   console_iap_client_id = "<CLIENT_ID>.apps.googleusercontent.com"
   console_members       = ["user:<your-google-account>@gmail.com"]
   # console_domain      = "console-dev.<your domain>"   # optional; unset uses <ip>.sslip.io
   ```

3. `terraform -chdir=infra/environments/dev plan -out=dev.tfplan`, review it, and `terraform -chdir=infra/environments/dev apply dev.tfplan`.
4. With a domain, point an `A` record at the output `console_ip`. Without one, the output `console_url` is already an `sslip.io` name (fine for dev; use a real domain for stage and prod). The managed certificate needs up to about an hour before HTTPS works.
5. Open `console_url` (it ends in `/console`) and sign in. An account not in `console_members` gets IAP's "You don't have access" page.

This adds about 18 USD a month.

**Logs.** Console → Logging → Logs Explorer, or:

```powershell
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="postly-dev-web"' --limit 50 --freshness 1h
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="postly-dev-migrate"' --limit 50
```

Dev keeps logs 7 days.

**WhatsApp, Instagram, Facebook and payments are not real on dev.** The image accepts only `POSTLY_PROVIDERS=simulators` (`src/config.ts`) until the vendor adapters (WP-41), and media lives in process memory. So no WhatsApp number answers, nothing is posted to Instagram or Facebook, and no payment is taken. The dev sandbox (WP-51, being built in a separate session) is meant to let you use dev by hand on top of the simulators, for example a sandbox chat page where you talk to Postly as the owner and see what would be posted; its scope is set in its own package, not here.

**Alerts** go to `alert_email` (Cloud Monitoring, notification channel "Postly dev on-call"; you get a confirmation email first):

- web health check failing (the uptime check on `/healthz`);
- web 5xx responses (more than 5);
- error log lines from any `postly-dev-*` service or job (more than 10);
- Cloud SQL CPU above 80% or disk above 85%.

Before the first deploy and during the three-pass apply, the uptime alert may fire; that is expected.

## 8. How to tell it worked, and common errors

It worked when: the last Deploy run is green, `/healthz` returns `{"ok":true}`, `gcloud run services list` shows web, worker and console ready, the last `postly-dev-migrate` execution succeeded, and no alert is open.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `SERVICE_DISABLED`, "API has not been used in project" | an API was enabled seconds ago and has not propagated | wait 2 to 5 minutes and run `plan`/`apply` again |
| `billing account ... is not open` or "billing must be enabled" | billing not linked, or the account is closed | `gcloud billing projects describe $PROJECT`; link it again (step 2) |
| `403` / `Permission denied` on a service account or secret right after it was created | IAM propagation takes up to a few minutes | wait, then apply again; do not add broader roles |
| Deploy: `Permission 'iam.serviceAccounts.getAccessToken' denied` or the auth step fails | the Workload Identity binding has not propagated, or the run is not on the `dev` branch | wait 5 minutes and rerun; run it from `dev` only |
| `Image ... not found` creating a Cloud Run service | the `bootstrap` image was not pushed | do pass 1 of step 4b |
| A service is unhealthy or its revision failed before the first deploy | the database had no logins yet (migrate not run) | run `gcloud run jobs execute postly-dev-migrate --region me-west1 --wait`, then apply again |
| Deploy job shows **skipped** | `POSTLY_DEPLOY_DEV` is not `true` | the GitHub part of the apply did not run; check `GITHUB_TOKEN` and apply again |
| `GET .../branches/dev: 404` or `403 Resource not accessible by personal access token` | token missing a permission or the repository | recreate it with the four write permissions in step 1 |
| `uptime_url check has malformed host`, or `public_base_url must be https://<lowercase host>` | `terraform.tfvars` still has a placeholder such as `public_base_url = "https://REPLACE_WITH_WEB_HOST"` | delete the `public_base_url` line (dev uses its `run.app` URL), then apply again |
| `backup retention should be >= transaction log retention` creating `postly-dev` | an older checkout kept 7 days of transaction logs with only 3 backups | update to `main`, where the log retention follows the backups kept, then apply again |
| `must specify a restriction on "resource.type" in the filter` creating an alert | an older checkout of the monitoring module | update to `main`, then apply again |
| `Error acquiring the state lock` | an earlier apply was interrupted | make sure nothing else runs, then `terraform force-unlock <id>` |
| A process logs `MESSAGING_WEBHOOK_SECRET is required` | the generated secret has no version | apply again; Terraform writes it (`stack/secret_values.tf`) |

## 9. Tear dev down

Dev has no deletion protection, so it can be removed completely:

```powershell
terraform -chdir=infra/environments/dev destroy
```

10 to 20 minutes. It removes the services, the database (and its data), the bucket and its media, the secrets, and on GitHub the `dev` environment, its variables, `POSTLY_DEPLOY_DEV`, the branch protection and the `dev` branch. The APIs stay enabled (free). If the private services connection refuses to delete, wait a few minutes and run `destroy` again.

To stop all charges, also delete the project (this deletes the state bucket too):

```powershell
gcloud projects delete $PROJECT
```

Left running, dev costs about 280 to 330 USD a month (step 2), whether or not anyone uses it.
