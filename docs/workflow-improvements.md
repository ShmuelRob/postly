# Workflow Improvements: From Prompt to Dev

Status: proposal, 2026-11-07. Nothing here is in effect. Every change to rules, CLAUDE.md, repository settings or the app's settings waits for the human's decision. The Hebrew summary is [workflow-improvements.summary.he.md](workflow-improvements.summary.he.md).

The human asked for the whole path from their prompt to code running on dev to be better and faster. This doc measures that path, names where the time goes, and proposes changes ranked by impact against effort.

## What the path looks like today

1. The manager plans and starts a development session in a new worktree, with a brief that says to check out `origin/dev`.
2. The developer writes docs, tests and code, runs `npm run check`, and opens a squash PR to `dev`.
3. One reviewer session reviews every file and posts a comment that starts with "APPROVED" for an exact SHA, then messages the merge queue.
4. The merge-queue session waits for `check` to pass on that SHA and runs `gh pr merge --squash --match-head-commit`.
5. The push to `dev` runs Deploy: CI and Infra again, then the image build, the migration job and the rollout.

## Measurements

From the 33 PRs merged into `dev` between 2026-11-05 and 2026-11-07 (`gh pr list --state merged`) and the last 100 workflow runs (`gh run list`).

| What | Value |
| --- | --- |
| CI on a PR, wall time | median 2.1 min, p90 2.8 min (jobs run in parallel: static 0.7, unit 0.5, db 1.2, design 1.7, e2e 1.8 min) |
| Infra on a PR | median 2.2 min (the image job is the longest at 2–2.5 min) |
| Deploy on a push to `dev` | median 6.9 min, p90 11.1 min (of which the deploy job itself is about 5 min) |
| PR opened → merged | median 12 min; 3 PRs took 14–16 h, all waiting overnight |
| PRs that touched a shared file (`human-review-queue.md`, its Hebrew summary, `implementation-plan.md`, its Hebrew summary, `drizzle/meta/_journal.json`) | 22 of 33 |
| PRs that needed one or more merges of `dev` into the branch | 16 of 33 (up to 4 merges in one PR: #134) |
| PRs that changed only docs | 6 of 33, median 10 min open → merged |
| CI failures on PRs | 5 of 40 runs; Infra 3 of 39, all `terraform fmt -check` |

What the numbers say:

- **CI is fast; the local full check is not.** The whole suite takes about 2 minutes on GitHub's runners. On this machine, with six or seven sessions at once, the same check times out. The local full check costs more than it buys.
- **Time from PR open to merge is already short when nothing goes wrong.** The hour a hotfix takes is spent before the PR opens (the local check, waiting for a free CPU) and in the handoffs (reviewer → message → merge queue → manager relay), not in CI.
- **Conflicts come from shared files, not from code.** Two out of three PRs touch a file that every other PR also touches, and half of them needed at least one catch-up merge. Each catch-up merge costs a new CI run, a delta review and a message round, about 15–30 minutes of elapsed time.
- **Branch protection on `dev` is not strict** (`strict: false`, required check `check`, zero required reviews), so a PR does not have to be up to date with `dev` to merge. Only a real textual conflict forces a catch-up merge. Removing the textual conflicts removes the catch-up merges.
- The real development time before a PR opens cannot be measured from git: sessions commit near the end, so a PR's first commit is usually minutes before it opens.

## Recommendations, ranked

Impact is elapsed time saved per PR or per day across all sessions. Effort is the work to make the change. Every item names who must approve it.

| Rank | Item | Impact | Effort | Approves |
| --- | --- | --- | --- | --- |
| 1 | [A light local gate; CI is the full gate](#1-a-light-local-gate-ci-is-the-full-gate) | High | Very low | Human (CLAUDE.md rule) |
| 2 | [Review-queue items as one file per PR](#2-review-queue-items-as-one-file-per-pr) | High | Low | Human (process, H-gate bookkeeping) |
| 3 | [Reviewer status check plus GitHub auto-merge](#3-reviewer-status-check-plus-github-auto-merge) | High | Low | Human (repository settings, merge rules) |
| 4 | [Worktrees cut from `dev`](#4-worktrees-cut-from-dev) | Medium | Very low | Human (local git setting or hook) |
| 5 | [Package status leaves feature PRs](#5-package-status-leaves-feature-prs) | Medium | Low | Human (plan rule) |
| 6 | [Deploy pre-flight for environment variables](#6-deploy-pre-flight-for-environment-variables) | Medium (prevents a broken deploy) | Low–medium | Human (deploy workflow, H8 area) |
| 7 | [Migrations: one in flight, generated last](#7-migrations-one-in-flight-generated-last) | Medium | Low | Human (H4 area) |
| 8 | [One shared test Postgres, a database per run](#8-one-shared-test-postgres-a-database-per-run) | Medium | Medium | Human (test infrastructure) |
| 9 | [Lanes by change size: docs-only and hotfix](#9-lanes-by-change-size-docs-only-and-hotfix) | Medium | Low | Human (review rule) |
| 10 | [Flaky e2e tests: one timeout policy, a quarantine report](#10-flaky-e2e-tests-one-timeout-policy-a-quarantine-report) | Medium | Medium | Human (e2e rule: never weaken a failing test) |
| 11 | [Small CI fixes](#11-small-ci-fixes) | Low–medium | Low | Human (workflows) |
| 12 | [Brief and PR templates](#12-brief-and-pr-templates) | Low–medium | Very low | Human (plan template) |

The top five give most of the gain and none of them changes product code.

### 1. A light local gate; CI is the full gate

**Problem.** CLAUDE.md says to run `npm run check` before finishing any change. Locally that starts up to three Postgres containers per session (the `db`, `e2e` and `e2e-browser` projects each have their own `globalSetup` in `vitest.config.ts`, and each one starts a container and runs all 26 migrations), plus Chromium for the design and browser projects. With six or seven sessions, that is up to 21 containers and a dozen browsers on one machine. Checks time out after the tool's 120-second limit, and sessions fall back to "CI decides" anyway, after spending the time.

**Change.**

- Add `npm run check:local`: `typecheck`, `lint:conflicts`, `lint:links`, `lint:boundaries`, then `vitest related --run --project unit <changed files>` (files changed against `origin/dev`). No Docker, no browser. Expected run time well under a minute.
- A session that changed database code (`src/db/`, `drizzle/`, a `*.db.test.ts`) also runs only the db test files it touched or that import what it touched, against the shared Postgres in item 8, once that exists.
- A session that adds or changes an end-to-end test still runs that one test locally, to produce the report the human sees (CLAUDE.md, workflow step 3). It does not run the whole e2e project.
- CI stays the full gate: `npm run check` on every PR, unchanged. A PR is not "done" until `check` is green; that is already true, since the merge needs it.
- Change the CLAUDE.md line to: "run `npm run check:local` before pushing; CI runs `npm run check` and is the gate".

**Time saved.** 5–20 minutes per PR, and far more when the machine is loaded, since the check no longer waits for a CPU. It also frees the machine for the sessions that do need Docker.

**Risk.** A failure the light gate misses shows up in CI two minutes later, costing one more push. That is cheaper than a local full check that times out. The end-to-end rule is unchanged: e2e tests still run in full in CI on every PR, and still block the merge.

**Approves.** The human: it changes a CLAUDE.md rule.

### 2. Review-queue items as one file per PR

**Problem.** Every PR that touches a human-review area adds a row to the table in `docs/human-review-queue.md` and a line to `docs/human-review-queue.summary.he.md`. Both files change in most PRs, always at the same spot (the end of the table), so any two open PRs conflict. Item numbers are first-merged-wins, so the second PR must also renumber.

**Change.**

- New items go into `docs/review-queue/`, one file per PR, named by the PR number: `docs/review-queue/pr-135.md`. The PR number is unique and known as soon as the PR opens, so no numbers are handed out and two PRs never write the same file.
- Each file has a small front matter (`added`, `pr`, `gates`, `status`) and the "what to review" text in English, followed by a two- or three-line Hebrew summary in the same file. This satisfies the Hebrew-companion rule for the item without touching a shared Hebrew file. (The human decides whether an item counts as "a document" that needs a separate companion file; this proposal says it does not.)
- `docs/human-review-queue.md` keeps its intro, the status values, items 1–73 as they are, and the decisions section. It links to the directory and stops growing. Its Hebrew summary changes once, to say the same.
- A small script, `npm run review-queue`, prints the open items as one table (from the front matter), for the human and for the work board. The index is generated on demand and never checked in, so it cannot conflict. A CI test checks that every file in the directory has valid front matter and a Hebrew section.
- When the human marks an item `ok` or a finding, only that item's file changes.

**Time saved.** Removes the most common conflict. On 2026-11-06 and 07 that is roughly one catch-up merge, one delta review and one extra CI run for most code PRs: 15–30 minutes each, and fewer messages.

**Risk.** Low. The human reads a list of files (or the script's table) instead of one long table; the board artifact can show the same list. Old items stay where they are, so no history is rewritten.

**Approves.** The human: it changes how gates H1–H8 are tracked and the Hebrew-companion convention.

**Cheaper stopgap, if the human prefers to keep one table.** A `.gitattributes` line `docs/human-review-queue.md merge=union` (and the same for its summary) lets a local `git merge origin/dev` keep both sides' appended rows without a conflict. Two caveats. First, GitHub's own conflict detection may not apply the union driver, so a PR can still show as conflicting until the author merges `dev` locally; this must be tried on a test PR before relying on it. Second, if both sides edit the same row (a status change), union keeps both versions and silently duplicates the row; a CI check for duplicate item numbers would have to catch that. The directory is cleaner. `merge=union` is not safe for `drizzle/meta/_journal.json` (JSON) or for any table whose rows get edited.

### 3. Reviewer status check plus GitHub auto-merge

**Problem.** A reviewer approves by comment, then must message the merge queue, which watches CI and merges. The app caps session-to-session messages at 10 per human turn, so reviewers get paused before they can notify the queue, and the manager relays approvals by hand. The merge queue is a whole session whose job is waiting.

**Change.**

- The reviewer records its verdict as a **commit status** on the exact SHA it reviewed, instead of only a comment:
  `gh api repos/ShmuelRob/postly/statuses/<SHA> -f state=success -f context=review -f description="Approved by reviewer-<N>"`.
  It still posts the grouped review comment, as today.
- A commit status belongs to one SHA. A new push (a conflict merge, a fix) has no `review` status, so the approval does not carry over by construction, which is what `--match-head-commit` protects today.
- Add `review` as a second required status check on `dev`, next to `check`.
- Turn on the repository's "Allow auto-merge" setting (it is off today). After posting the status, the reviewer runs
  `gh pr merge <N> --auto --squash --delete-branch --match-head-commit <SHA>`.
  GitHub merges by itself the moment both `check` and `review` are green at that SHA, and refuses if the head moved.
- GitHub's native **merge queue** is not available here: it needs a repository owned by an organization, and this one is owned by a user. Auto-merge gives the same result for this repository, since `dev` does not require branches to be up to date.
- The merge-queue session shrinks to the one thing GitHub does not do: scanning open PRs for conflicts. That scan can become a scheduled GitHub Action that comments "conflicts with dev" on the PR (which the author's session sees through PR notifications) instead of a session using messages.
- Promotion PRs (`dev` → `stage` → `main`) keep using a merge commit and the human's approval; nothing changes there.

**Time saved.** Removes one or two message hops and the manual relays per PR: 5–15 minutes per PR, and the manager's attention. A PR merges two minutes after its last approval, even when no session is awake.

**Risk.** Any session runs as the same GitHub user, so any session could post a `review` status, just as any session can merge today; the trust model does not change. A reviewer that posts the status on the wrong SHA approves that SHA only, which is the same as a wrong comment today. A required check named `review` blocks the human's own direct merges until it is posted; the human can post it or merge as admin (`enforce_admins` is on today, so the human would post it).

**Approves.** The human: repository settings (auto-merge, required checks) and the merge rules in the manager playbook.

### 4. Worktrees cut from `dev`

**Problem.** New session worktrees start from a `main` about 30 commits behind `dev` (33 today), and every brief has to repeat `git fetch origin && git checkout -B <branch> origin/dev`. A session that forgets builds on stale code and then conflicts.

**Cause found.** In the main checkout, `refs/remotes/origin/HEAD` still points to `origin/main`, though GitHub's default branch has been `dev` since 2026-11-05. The app has no base-branch setting (its settings are the branch prefix and archiving), so it most likely follows `origin/HEAD` or the local `main`.

**Change.**

- Run once in `C:\dev\postly`: `git remote set-head origin dev` (or `git remote set-head origin --auto`, which reads the default from GitHub). Then start one test session and check that its worktree is on `dev`'s tip.
- If the app still cuts from local `main`, add a `SessionStart` hook in the project's `.claude/settings.json` that, in a worktree whose branch has no commits of its own, runs `git fetch origin dev` and `git reset --hard origin/dev`. The hook does nothing on a branch that already has commits.
- Either way, keep the line in the brief template until the fix is verified, then drop it.

**Time saved.** A few minutes per session, and the occasional stale-base conflict.

**Risk.** Very low for `set-head`. The hook resets the branch only when it has no commits of its own, so it cannot discard work; it should still be reviewed before it is added.

**Approves.** The human: a local git setting, or a settings hook.

### 5. Package status leaves feature PRs

**Problem.** `docs/implementation-plan.md` holds every work package and its status in one table, and its Hebrew summary lists the phases. The manager edits statuses, and feature PRs sometimes add or edit package rows. Both kinds of edit land in the same lines.

**Change.**

- Feature PRs never edit `implementation-plan.md` or its summary. If a package's text needs a change, the session reports it, and the manager makes it.
- The manager batches status changes and new packages into one docs-only PR per wave (or per few hours), not one per change. #130, #138 and #140 on 2026-11-06 and 07 are three such PRs that could have been one.
- The live status lives on the work board artifact, which the manager already updates on every state change. The plan's status column is updated in the batched PR. (Alternative the human may prefer: drop the status column from the plan and keep status only on the board.)

**Time saved.** Removes the second most common conflict, and some docs-only PRs and their reviews.

**Risk.** The plan's status can lag the board by up to one batch. The board is the place to look for live status.

**Approves.** The human: it changes the plan's rules.

### 6. Deploy pre-flight for environment variables

**Problem.** A deploy shipped code that required a new environment variable before Terraform set it. The worker crashed on start and the human had to apply Terraform and re-run the deploy. Nothing in CI knew the two were out of step.

**Change.**

- **In CI (static, every PR).** `src/config.ts` already parses the environment with Zod. Export the list of variables it requires for a cloud environment, and add a test that compares that list with the `env` and `secret_env` keys Terraform sets for the Cloud Run services (`infra/modules/cloud_run`, `infra/environments/*`). A variable the code requires and Terraform does not set fails the PR. A variable that Terraform sets and the code requires only after this PR is fine, and is what marks the PR as "needs a Terraform apply first".
- **In Deploy (before the migration job).** A step reads the environment variable names of each live service (`gcloud run services describe "$PREFIX-worker" --format json`, names only, never values) and compares them with the list from the new image. If one is missing, the job fails before the migration and before any rollout, with a message naming the variable and saying to apply Terraform first. The running revision is untouched.
- **PR template.** A checkbox "needs `terraform apply` before deploy" with the variable or resource names; the reviewer checks it against the diff. With the check above, the box is a reminder, not the safeguard.

**Time saved.** Each avoided broken deploy saves the human a debugging round, a manual apply and a re-run: 20–60 minutes, at a time when the human may not be present.

**Risk.** Low. The pre-flight reads only names from Cloud Run, never secret values. It needs `run.services.get`, which the deploy service account already has to deploy.

**Approves.** The human: the deploy workflow and the Terraform-related checks sit in the H8 area.

### 7. Migrations: one in flight, generated last

**Problem.** Migration numbers and `drizzle/meta/_journal.json` are first-merged-wins. Two PRs with a migration both write the next number and both append to the journal, so the second one renumbers, regenerates, and gets re-reviewed.

**Facts checked.** drizzle-kit can name files by timestamp (`migrations: { prefix: 'timestamp' }` in `drizzle.config.ts`), which avoids the file-name clash. It does not remove the clash: the journal is still one JSON array that both PRs append to, and each snapshot points at the previous one (`prevId`), so two parallel migrations still produce a broken chain that one PR must regenerate. Timestamp names alone are not worth the change, and WP-98 is about to squash all migrations into one base migration anyway.

**Change.**

- Treat "has a migration" as a lane of its own: at most one open PR with a migration at a time. The manager hands out the token when it starts the session, as it already hands out numbers when they collide.
- The session writes its schema change and tests first, and runs `npm run db:generate` as its last step, right after merging `origin/dev`, so the number and the snapshot chain are current when the PR opens.
- Add `drizzle-kit check` to the static CI job, so a broken snapshot chain fails in CI and not in a reviewer's read.

**Time saved.** Removes renumbering churn: one regenerate, re-review and CI run per clash.

**Risk.** Packages with migrations wait for each other. Today there are few in parallel, and most of those are core-lane work that is already serialized by files.

**Approves.** The human: migrations are an H4 area.

### 8. One shared test Postgres, a database per run

**Problem.** Every test run starts its own Postgres container for each database project (up to three per run) and runs all migrations in each. With several sessions that is the main load on the machine, after the browsers.

**Change.**

- One long-running local container, `postly-test-pg` (`postgres:17-alpine`, started once by a script, with a CPU and memory limit).
- `test/db/start-database.ts` already accepts `TEST_DATABASE_URL` as a superuser URL to an empty database. Add a mode where, given the server's URL, it creates a fresh database per run from a **template database** that holds the migrated schema, and drops it when the run ends. `CREATE DATABASE … TEMPLATE …` takes about a second, instead of 26 migrations. The template is rebuilt when the set of migration files changes (keyed by a hash of `drizzle/`).
- Database names include the worktree and a run id, so sessions never share a database.
- CI keeps Testcontainers as today: one fresh container per job is the clean reference.

**Caveat.** Postgres roles and their attributes are global to the server, not per database. The migrations create the `app_*` logins idempotently, and the tests set the same test password, so separate databases can share them. A branch whose migration changes a role's attributes (as `0013_console_columns_role_attributes` did) would change them for every other session's databases too. Such a branch runs its db tests with `isolated: true` (its own container, an option `start-database.ts` already has). The `least-privilege` db test should also run in CI only, where the server is its own.

**Time saved.** 20–60 seconds per run in container start and migrations, and most of the CPU and memory pressure from parallel sessions.

**Risk.** Medium: a mistake in database naming or cleanup could let two runs see each other's data. Orphaned databases from crashed runs need a cleanup (drop databases older than a day on start).

**Approves.** The human: test infrastructure. This is worth doing after items 1 and 2, which remove most of the need to run the db tests locally.

### 9. Lanes by change size: docs-only and hotfix

**Problem.** A docs-only PR or a one-file hotfix goes through the same handoffs as a 50-file feature: a separate reviewer session, a message, the merge queue. The hotfix on 2026-11-07 (#141) took about an hour from diagnosis to merge, most of it before the PR opened.

**Change.**

- **Docs-only PRs** (only `docs/` and root `*.md`): the reviewer reviews and, if nothing blocks, posts `review` and enables auto-merge in one step (item 3). CI for such a PR is about a minute (Infra already skips the image for docs-only diffs; CI could skip the test jobs too, see item 11). Docs that change a contract or a human gate (`state-machines.md`, `database-schema.md`, `contracts.md`, the review queue's gate decisions) do not take this lane.
- **Hotfix lane** for a red `dev` or a broken dev deploy: the developer runs the light gate (item 1) and opens the PR at once, without the full local check. A reviewer is started at the same time as the developer, not after the PR opens, so it can read the diagnosis while the fix is written. The review is of the diff only, and the merge is by auto-merge. A hotfix that touches an H-gate area still gets its review-queue file.
- Reviewers stay separate from authors in both lanes; nobody approves their own change.

**Time saved.** 10–30 minutes per docs-only PR or hotfix.

**Risk.** Low, as long as the lane's file list is checked by a script and not by judgment.

**Approves.** The human: it changes the review rule.

### 10. Flaky e2e tests: one timeout policy, a quarantine report

**Problem.** e2e tests that pass in CI fail locally under load, and the other way round, and timeouts differ between the two. A flake costs a re-run and a person's time to decide it was a flake.

**Change.**

- One timeout table in `vitest.config.ts`, the same locally and in CI, with the local light gate (item 1) not running the e2e project at all. Most local-only flakes come from load, and they go away with it.
- In CI, add Vitest's `retry: 1` for the e2e project only, and have the e2e reporter mark a test that passed on retry as **flaky** in the report and in the job summary. The test still fails the build if it fails twice. A test marked flaky twice in a week becomes a fix task for the manager. This does not skip or weaken any test; it makes flakes visible instead of re-run by hand.
- Tests that wait on timing (debounce windows, `processedAt` races, as fixed in #124 and #126) use the injected clock and explicit "wait until" helpers, not sleeps. This is a rule for new tests and a fix task for the ones the flaky report finds.

**Time saved.** One re-run and a diagnosis per flake.

**Risk.** A retry can hide a real intermittent bug. The flaky marking and the fix-task rule are what keep it from being hidden.

**Approves.** The human: CLAUDE.md forbids weakening a failing e2e test, so a retry policy is the human's call.

### 11. Small CI fixes

- **`terraform fmt` before pushing.** All three Infra failures in the sample were `terraform fmt -check`. A line in the brief ("run `terraform fmt -recursive infra` when you touch `infra/`") or a pre-commit hook removes them.
- **Path filters on CI.** A docs-only PR runs the static job only (links, conflicts); the test jobs report success without running, so the required `check` still passes. Saves runner time more than wall time, since CI is already parallel.
- **No duplicate checks after the merge.** Deploy re-runs all of CI and Infra on the merge commit before it builds the image. That is the right gate for a squash merge, since the squashed commit was never tested as-is. Keep it. The repeated image builds are being fixed separately by the "build-once" session (one image, built once and promoted); this proposal does not repeat that work.
- **npm and Playwright caches** are already in place. The Testcontainers image is pulled in parallel with `npm ci`. Nothing big is left here.

**Approves.** The human: the workflows.

### 12. Brief and PR templates

- The session brief template in `implementation-plan.md` gains: the light gate command (item 1), the review-queue file path for the PR (item 2), whether the package holds the migration token (item 7), and the lane (docs-only, hotfix, normal). Once item 4 is verified, it drops the `checkout origin/dev` line.
- A `.github/pull_request_template.md` with: what changed, the end-to-end report link, H-gate areas touched (with the review-queue file), "needs `terraform apply` before deploy" (item 6), and "has a migration".
- The reviewer brief gains the status-check and auto-merge commands (item 3).

**Approves.** The human: the plan's template is part of the rules.

## Ideas considered and not recommended

- **Test sharding.** CI is already split into parallel jobs and finishes in about 2 minutes; the longest job is under 2 minutes. Sharding would add complexity for seconds. Locally the problem is the number of sessions, not one run's length.
- **Generating the Hebrew summaries in CI.** The summaries are short, human-shaped Hebrew, and the rule is that a person can read them. Machine generation in CI would need a model (no paid LLM in tests or CI), and once items 2 and 5 are done, the shared summaries rarely change.
- **Timestamp migration names.** See item 7: they rename files but do not fix the journal and snapshot chain.
- **GitHub's native merge queue.** Not available for a repository owned by a user; auto-merge covers the need (item 3).

## Suggested order

1. Items 1, 4 and 11 (`terraform fmt`): no product code, can be in effect the same day.
2. Items 2, 3 and 5 together, in one docs-and-settings change, since they all change how a PR is closed out.
3. Item 6, then item 7.
4. Items 8, 9, 10 and 12 as the load shows they are needed.

Each item, once the human approves it, becomes a work package with the usual docs-first and tests-first rules.
