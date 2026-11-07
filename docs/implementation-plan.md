# Postly Implementation Plan

Status: active. Contracts approved on 2026-11-02; styles and example set are provisional.

This plan splits Phase 1 into work packages that coding-agent sessions build one package at a time. A manager session runs the loop described in [Session manager](#session-manager): it starts a session for each package that is ready, verifies the result, brings human gates to the human, and repeats until every package is done. The plan follows [PRD.md](../PRD.md), [technical-design.md](technical-design.md), and [agentic-development.md](agentic-development.md). When it conflicts with them, they win and this plan is fixed.

## Rules every session follows

- Read CLAUDE.md, the three source-of-truth docs, and the contract doc that covers the package before writing code.
- Docs first: a package that needs a decision missing from the docs stops, reports the gap to the manager, and writes no code around it.
- TDD: failing tests first, then code. A package is done only when its end-to-end test passes and its report is shown to the human.
- Stay inside the package's files. Any change outside them is reported, not made.
- Never skip, weaken, or delete a failing end-to-end test.
- One branch and one pull request per package, named `wp/<id>-<slug>`, targeting `dev` ([deployment.md](deployment.md#terraform): `dev` → `stage` → `main` is the promotion path; `main` is prod). Developer sessions never merge: a reviewer approves the exact SHA and GitHub auto-merges it ([operating mode](#operating-mode)).
- Run `npm run check:local` before pushing (typecheck, conflict markers, links, boundaries, the review-queue files, and the unit tests related to the files changed against `origin/dev`; no Docker, no browser). CI runs `npm run check` on every PR and is the gate: a PR is done only when `check` is green. A session that adds or changes an end-to-end test still runs that test locally (`npx vitest run <file>`) and shows the human its report.
- A session that touches `infra/` runs `npm run fmt:infra` (`terraform fmt -recursive infra`) before pushing; `check:local` runs `terraform fmt -check` when `infra/` changed.
- Feature PRs never edit this plan or its Hebrew summary. A package whose text needs a change reports it, and the manager makes the change ([operating mode](#operating-mode)).
- Every PR fills in the [pull request template](../.github/pull_request_template.md), and a PR that touches a human-review area adds its own review-queue file, `docs/review-queue/pr-<N>.md` ([review-queue/README.md](review-queue/README.md)).

## Lanes

| Lane | Meaning | Concurrency |
| --- | --- | --- |
| Core | State machines, data model, workflow runtime, main flows | One session at a time, across all core packages; from 2026-11-03 the human allows several when their files are disjoint (for example `src/db/` vs one module) and each merges the base branch into its own when the others land (never rebase) |
| Migration | Any package whose PR adds or changes a file in `drizzle/` | One open PR with a migration at a time, across all lanes; see below |
| Parallel | Independent modules behind a set contract: design engine, adapters, console | Up to three sessions at once, each in its own worktree, never two on the same files |
| Human | Decisions and approvals only the human can give | Blocks every package that depends on it |

**Migrations: one in flight, generated last** (decided 2026-11-07, item 7 of the workflow proposal in PR #142). Migration numbers, `drizzle/meta/_journal.json` and the snapshot chain (each snapshot's `prevId`) are first-merged-wins, so two open PRs with a migration always clash. The manager holds one migration token and hands it out in the brief of the session it starts for such a package. A package that needs a migration while the token is taken waits, or does its other files first and adds the migration once the token is free. The session writes its schema change and its tests first, and runs `npm run db:generate` (or adds its hand-written migration) as its last step, right after merging `origin/dev`, so the number and the chain are current when the PR opens. The token returns to the manager when the PR merges or closes. CI's static job runs `npm run db:check` (`drizzle-kit check`), which fails a PR whose snapshots no longer form one chain.

### Change-size lanes

Set by the human on 2026-11-07 ([workflow-improvements.md](https://github.com/ShmuelRob/postly/pull/142), item 9). They change how a PR is reviewed and merged, not who reviews it: a reviewer is always a separate session from the author, and nobody approves their own change.

| Lane | Which PRs | How they close |
| --- | --- | --- |
| Normal | Every PR not in another lane | A reviewer session starts after the PR opens and follows the [reviewer brief](#reviewer-brief) |
| Docs-only | `npm run lane:docs-only` passes on the branch: every changed file is `docs/**/*.md` or a top-level `*.md`, and none is a contract or gate doc or a doc a test reads (listed below) | The reviewer reviews and, if nothing blocks, posts `review` and turns on auto-merge in one step. CI runs only its `static` job; the test jobs are skipped and `check` still reports success |
| Hotfix | A red `dev` or a broken dev deploy | The developer runs `npm run check:local` and opens the PR at once. The manager starts the reviewer at the same time as the developer, so it reads the diagnosis while the fix is written; it reviews the diff only, and the merge is by auto-merge. A hotfix that touches a human-review area still adds its review-queue file |

The docs-only lane is decided by the script (`scripts/lane.ts`), never by judgment. Its exclusions: the contract docs and their Hebrew summaries (`docs/state-machines.*`, `docs/database-schema.*`, `docs/contracts.*`); the gate decisions (`docs/human-review-queue.*` and `docs/review-queue/`); and every doc whose path a `*.test.ts` file names, since its tests must run when it changes. A PR in an excluded file takes the normal lane.

## Operating mode

Set by the human on 2026-11-02. It overrides the waiting steps in the gates, the loop, and the brief below until the human changes it.

- **Gates no longer block, with two exceptions.** A gate that spends real money (a paid vendor plan, a real payment) or deploys to any cloud environment (WP-44, anything that creates cloud resources) still waits for the human. Every other gate becomes a queued review: the work goes ahead, and the PR adds its own item file, `docs/review-queue/pr-<N>.md`, with what to look at and the gates it stands in for ([review-queue/README.md](review-queue/README.md); the numbered items already in [human-review-queue.md](human-review-queue.md) stay there, and it no longer grows). The human reviews the queue at their own pace (`npm run review-queue` prints the open items as one table); a finding becomes a fix package.
- **Human-owned tests (H5).** Until the human writes them, a test-author session that does not implement writes the approval and publishing tests on their own branch, the reviewer checks them against the docs, and they merge before the implementing session starts. The implementing session may not change them; a test it believes is wrong is reported, not edited. The tests are queued for the human.
- **Human-authored content (H2, H3, H6, H7).** Sessions draft the Hebrew copy, templates, prompts, styles, and example set from the docs, mark them provisional, and queue them for the human.
- **Reviewer session.** A reviewer session, separate from every developer session, takes over loop steps 4 to 6 for a pull request ([reviewer brief](#reviewer-brief)): it reads every file, checks the PR's review-queue file, and posts one grouped review comment. If nothing blocks, it approves the exact SHA it reviewed by posting a `review` commit status on it and turns on auto-merge pinned to that SHA; GitHub squash-merges the PR the moment `check` and `review` are both green there, and refuses if the head moved. A commit status belongs to one SHA, so a new push needs a new review of the delta and a new status. It never writes product code beyond trivial fixes it states in the PR.
- **Merge-queue session.** Its only job is the conflict scan: it lists open PRs that conflict with `dev` and tells each author's session (or the manager) to merge `dev` in. It no longer waits on CI or merges, except during the switch-over below.
- **Switch-over order.** (1) The PR that wrote this rule merges. (2) From then on reviewers post the `review` status and run `gh pr merge --auto`. (3) The manager turns on the repository's "Allow auto-merge" setting and then adds `review` as a second required status check on `dev`, next to `check`. Until step 3 is done, `gh pr merge --auto` fails ("auto-merge is not allowed"), and the merge-queue session merges as before, `gh pr merge <N> --squash --delete-branch --match-head-commit <SHA>` once `check` is green at the approved SHA. Once `review` is required, a PR without a reviewer's status cannot merge; the human's own direct merges post the status themselves (`enforce_admins` is on).
- **Plan status.** Feature PRs never edit this plan or its Hebrew summary. The live package status is on the manager's work board; the manager batches status changes and new packages into one docs-only PR per wave (or every few hours), so the status column here can lag the board by one batch.
- **Vendor accounts.** Packages that need vendor test accounts or keys (WP-41) stay blocked until the human provides them, since agents do not create accounts.

## Human gates

| Gate | What the human provides or approves | Blocks | State |
| --- | --- | --- | --- |
| H1 | Approve state-machines.md, database-schema.md, and contracts.md, and drop their "draft" status | Every core package | Passed 2026-11-02 |
| H2 | Style rule spec for Clean, Warm, and Dynamic, licensed Hebrew fonts, and output sizes per network | WP-11 to WP-13 | Accepted for now on 2026-11-03; WP-14 makes the styles professional |
| H3 | The real Hebrew example set: businesses, photos, weekly updates, and expected outcomes | WP-12, WP-13, WP-21 prompt evaluation | Accepted on 2026-11-03: the provisional set is the working set until the human brings a better one |
| H4 | Review of the generated migration and the RLS policies | WP-20 merge | Open |
| H5 | Writes or approves the approval and publishing tests before implementation | WP-33, WP-34 | Accepted on 2026-11-03: a test-author session writes the tests, under the operating mode |
| H6 | Conversation copy, WhatsApp template text, and channel connection guidance in Hebrew | WP-30, WP-31, WP-34 | Accepted for the demo on 2026-11-03; drafts are queued |
| H7 | Review of every customer-facing prompt | WP-21 merge and every package that adds a prompt | Open |
| H8 | Review of tokens, secrets, and customer media handling | WP-41, WP-44 | Open |

## Decisions

The tooling choices and operational defaults are recorded in [technical-design.md](technical-design.md) (Stack and Operational defaults), and the output sizes and fonts in [design-styles.md](design-styles.md). Human decisions on 2026-11-03 (review queue items 1 to 7): H2 styles accepted for now, to be made professional later (WP-14); H3 the provisional set is the working set until the human brings a better one; H5 the test-author approach is accepted; H6 drafted copy is fine for the demo.

An update that arrives after the week cutoff counts as next week's update (decided by WP-31 on 2026-11-03 and queued for the human as review queue item 20; see [technical-design.md](technical-design.md#weekly-update-flow)).

Contract gaps found while building the simulators (WP-03). Each is a contract change that the named package proposes in the docs, and queues for the human, before its implementation:

- `ModelProvider` requests carry no task name; the simulator matches the task by its output JSON Schema (`z.toJSONSchema` of the task's output). WP-21 either keeps that derivation in one shared helper or adds a task field. Settled by WP-21: both request types carry a `task` field (contracts.md, `ModelProvider`).
- `PaymentProvider` has no way to learn a `providerSubscriptionId` after payment (no webhook verification or lookup). WP-42 adds one. Settled by WP-42: `verifyWebhook` returns a `PaymentEvent` (contracts.md, `PaymentProvider`), on the sibling `PaymentWebhooks` interface.
- There is no typed error for sending outside the 24-hour WhatsApp window. WP-22 adds one, and WP-35 tests it.

## Work packages

Status values: `todo`, `blocked`, `in_progress`, `review`, `done`. Only the manager edits the status column, in its batched status PRs; the work board holds the live status.

### Phase 0: foundations

| ID | Package | Lane | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| WP-01 | Guardrails: module folders under `src/modules/<name>/` with a public `index.ts`, import rules (vendors only in adapters, no cross-module internals, no DB access without a business context helper), CI workflow | Core | none | CI fails on a seeded boundary violation and passes on main | done |
| WP-02 | End-to-end harness: Vitest `e2e` project, the in-process app wiring with simulators, and the HTML report writer | Core | WP-01 | A sample test produces a report the human can open | done |
| WP-03 | Simulators for `MessagingProvider`, `PublishingProvider`, `ModelProvider` (scripted fixtures per task), and `PaymentProvider`, plus shared contract tests that later run against real adapters | Parallel | WP-01 | Contract tests pass against every simulator | done |

### Milestone 1: design engine and Hebrew example set

| ID | Package | Lane | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| WP-10 | Example-set format and the provisional set: fixture layout, loader, Zod schema for entries, six fictional businesses, code-generated placeholder photos | Parallel | WP-01 | Loader validates every provisional entry | done |
| WP-11 | Design engine core: `TemplateRenderer` with Playwright and sharp, RTL layout, crop, logo and caption placement, per-network output | Parallel | WP-01, H2 (provisional) | Renders a test fixture in every style and network, checked by snapshot | done |
| WP-12 | The three style templates (one session per style once WP-11 is merged) | Parallel | WP-11, H2 | Each style renders the example set within its rules | done |
| WP-13 | Example-set runner: renders every example in every style into a screenshot gallery report | Parallel | WP-10, WP-12 | The human reviews the gallery on the provisional set; milestone 1 closes once it passes on the final styles and the real set | done |
| WP-14 | Design research and style upgrade: research what makes social posts effective (look first for existing skills and published rules), write the findings into design-styles.md, then update the three styles; also the style review items moved from WP-15 (shared `pre-line`, shared style-test helpers, snapshot renames) | Parallel | WP-12 | design-styles.md carries the researched rules and the styles render the example set within them | done |
| WP-15 | Cleanup from reviews: fixture phones to 0501234567 / +972501234567, versioned gitignored e2e reports per run, the link-checker fixture test; the style items (shared `pre-line`, test helpers, snapshot names) go to WP-14 and the flaky boundaries test to its own fix | Parallel | WP-12 | `npm run check` passes and the listed items are closed | done |

### Phase 2: core platform

| ID | Package | Lane | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| WP-20 | Database: migration from `schema.ts`, RLS policies, roles, `withBusiness()` transaction helper, test database setup | Core | H1, WP-02 | Tenant isolation tests prove one business cannot read or write another's rows; H4 passed | done |
| WP-21 | Model layer: task registry, versioned prompts, config table, Zod validation with retries, `model_run` records, console routing | Core | WP-20, WP-03 | Invalid simulator output retries and lands in `console_item`; H7 passed for any prompt | done |
| WP-22 | Messaging module: Fastify webhook, verification, deduplication, burst merge, sending, 24-hour window, unknown numbers to the console | Core | WP-20, WP-03 | End-to-end: duplicate and unknown-number messages behave as specified | done |
| WP-23 | Workflow runtime: apply an event with its guards inside one transaction, pg-boss worker wiring, handoff flag, pause flags | Core | WP-20 | Invalid transitions are rejected and logged; handoff stops automatic replies | done |
| WP-24 | Database hardening: a role per operation (least privilege) and composite `(business_id, id)` foreign keys, per database-schema.md | Core | WP-20 | Tests prove each role can reach only its tables and verbs, and a cross-business reference is rejected; before WP-33 | done |

### Phase 3: product flows

Each flow ends with an end-to-end test from an inbound WhatsApp message to what the owner and the networks see.

| ID | Package | Lane | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| WP-30 | Onboarding: intro, profile questions with extraction, brand assets, style samples, profile review, channel connection and test, business activation | Core | WP-21, WP-22, WP-23, WP-12, H6 | End-to-end onboarding in Hebrew, including voice answers | done |
| WP-31 | Weekly update: week rows, reminder template, transcription, fact extraction with verbatim quote check, weekly planning | Core | WP-30, H6 | End-to-end: update in, plan stored; no update leads to reminder then a skipped week | done |
| WP-32 | Drafts: caption writing, code fact check, `post_version` with content hash, rendering, sending with buttons, change requests, preference rules, the several-photos choice (carousel, one photo, a post per photo) | Core | WP-31 | End-to-end: a mismatched price blocks sending; a change creates a new version and a saved rule | done |
| WP-33 | Approval: button-only approval, approver number check, hash match, invalidation on any new version | Core | WP-32, WP-24, H5 | Human-owned approval tests pass | done |
| WP-34 | Scheduling and publishing: time proposals per profile and holidays, publications per channel, publishing job with the publishing guard and pause checks, retries with a provider status check, confirmation templates | Core | WP-33, H5, H6 | Human-owned publishing tests pass; end-to-end shows posts reaching the publishing simulator only after approval | done |
| WP-35 | Failure cases from the technical design: closed 24-hour window, no response, late approval, one channel failing, channel disconnect with daily health check, unknown number, failed model validation | Core | WP-34 | One end-to-end test per case | done |

### Phase 4: periphery

| ID | Package | Lane | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| WP-40 | Console (React): conversations, drafts, console items, handoff, retries, business and global pause | Parallel | WP-23 | Each console action is covered by a test through the console API | done |
| WP-41 | Real adapters: Twilio, Zernio, Google models; one session each | Parallel | WP-03, vendor decisions, H8 | Shared contract tests pass against the vendor's test account | todo |
| WP-42 | Billing: placeholder `PaymentProvider`, payment link in WhatsApp, subscription machine | Parallel | WP-22, WP-23 | End-to-end: payment link sent, status changes applied | done |
| WP-43 | Cancellation and data deletion schedule, monthly report | Core | WP-34 | End-to-end: cancellation disconnects channels immediately | done |
| WP-44 | Deployment: one image, web and worker on Cloud Run, Cloud SQL, Cloud Storage, secret manager, monitoring | Parallel | WP-22, WP-23, H8 | Stage runs the end-to-end suite with test accounts | in_progress |
| WP-45 | Local playground (React, local only, never deployed and kept out of the production image): a WhatsApp-style chat where the human plays the owner through the messaging simulator (text, voice notes as audio files, photos, reply buttons), a mock Instagram and Facebook feed showing what reached the publishing simulator, and a state panel (business, conversation and post states, the review queue). Starts with scripted simulator data; each flow becomes playable as WP-30 to WP-34 land | Parallel | WP-02, WP-03, WP-22, WP-23 (WP-30 to close) | The human can run `npm run playground` and play onboarding end to end on simulators, covered by an end-to-end test that drives the UI | done |
| WP-51 | **ASAP.** Simulated dev environment: `POSTLY_PROVIDERS=simulators` allowed only in `local`, `test` and `dev` (stage and prod refuse it at startup); the simulators' state and media in Postgres (`simulator` schema, own login) shared by web, worker and the sandbox; a dev-only sandbox service built from WP-45 (chat as owner and approver, mock feed, mock checkout with pay, fail and cancel) in its own image with no public invoker; Terraform for dev without vendor secrets ([deployment.md](deployment.md#simulated-mode-dev-wp-51)) | Parallel | WP-44, WP-45, WP-42 | End-to-end: onboarding, payment, draft, approval and publishing in simulated mode across a web and a worker composition on the Postgres store, and a test that stage and prod refuse the mode | done |

### Phase 5: audit trail and observability

Added from the human's review of the queue on 2026-11-04 (items 15 and 29, and the observability decision). Docs first for each package, with Hebrew summaries.

| ID | Package | Lane | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| WP-46 | Persisted workflow audit trail (item 15): a table recording every applied and every rejected workflow event (business, machine, from and to state, event, source, role, reason, time, actor, correlation id such as the message id), written in the same transaction as the transition, FORCE RLS and grants (H4), shown in the console. Keep everything for now; the docs decide whether it stays outside the business `on delete cascade` ([retention-checks.md](retention-checks.md)) | Core | WP-23, WP-40, H4 | An applied and a rejected event each leave one audit row, visible in the console, covered end to end | done |
| WP-47 | Observability: logging foundation. Structured logs across web, worker and jobs with request, business, message and job ids, and no customer content, phone numbers or secrets (H4, H8); a new observability doc with a Hebrew summary | Parallel | WP-44 | A test fails if a log line carries customer content or a secret; every job and request log has its ids | done |
| WP-48 | Observability: metrics and tracing. Cloud Trace through OpenTelemetry, Cloud Error Reporting, and metrics for messages in and out, drafts, approvals, publications by status and network, retries and failures, model run cost and latency, queue depth, and DB connections | Parallel | WP-47 | The metrics appear on the simulators locally and in `dev` | done |
| WP-49 | Observability: dashboards and alerts in Terraform (extending `infra/` monitoring): dashboards (including a per-business view), log-based metrics, uptime checks, SLOs, notification channels, and alerts for publishing failures, webhook errors, pg-boss backlog, worker not running, channel disconnected, cost spikes and 5xx | Parallel | WP-48, H8 | `terraform validate` and plan are clean; never applied by an agent | done |
| WP-50 | Observability: runbook. One entry per alert: what it means, how to check, what to do | Parallel | WP-49 | Every alert in WP-49 links to its runbook entry | done |

### Phase 5b: security debts

From the ranked debts in [security.md](security.md#technical-debts-ranked) (T3, #62). Already covered elsewhere: D5 and D6 by T11 (console column grants, `ALTER ROLE`), D11 by T2 (the durable burst claim), D13 by WP-41, D14 by WP-47; the dev mocks are WP-51. The rows are ordered by effort (quick fixes first), not by the security.md rank.

| ID | Package | Lane | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| WP-80 | D3: console CSRF and DNS rebinding. Check `Host` against an allowlist (loopback names locally, configured hosts deployed), require a JSON content type on every `POST`, and refuse a cross-origin `Origin` | Parallel | WP-40 | Console route tests refuse a foreign `Host`, a cross-origin `Origin` and a non-JSON `POST` | done |
| WP-81 | D8: `trustProxy` set to Cloud Run's single front-end hop on the deployed web and console processes, off locally; the IP is never used as authentication | Parallel | WP-44 | A test shows `request.ip` takes the last forwarded hop only, and a spoofed leftmost `X-Forwarded-For` is ignored | done |
| WP-82 | D1 and D4: console team sign-in (IAP on the console service or accounts in the app; the human chooses, H8) with the actor taken from the identity on every console action, including the global pause (`by` stays only as a note) and WP-46's audit rows | Core | WP-40, WP-46, H8 | A console action without an identity is refused; every action records the signed-in actor | done |
| WP-83 | D2: `cancel` needs a confirmation (the typed business name) before it starts; the actor comes from WP-82 once it lands | Core | WP-43 (WP-82 for the actor) | A cancel without the matching name is refused and nothing is scheduled; covered end to end | done |
| WP-84 | D9: per-process config (each command loads only the logins it uses) and a console service account that reads only its secrets, in Terraform (never applied by an agent) | Parallel | WP-44, H8 | `loadConfig` for `console` and `worker` needs only their passwords; `terraform validate` is clean | done |
| WP-85 | D12: per-route `bodyLimit` and a simple rate limit on the public webhooks and the console (or Cloud Armor in front of web) | Parallel | WP-22 | Oversized bodies get 413 and a flood gets 429 before the HMAC check | done |
| WP-87 | D7: size the database pools per process and per login from config, and check that the sum across web, worker and console stays under the Cloud SQL tier's `max_connections` with headroom (T4's tiers) | Parallel | WP-44, WP-84 | A test fails when the configured pools exceed the tier's limit; startup logs the total | done |
| WP-86 | D10: re-review the `set_config` accepted risk with T11's grants; decide on a guarded setter or keep the source guard (H4) | Core | T11, H4 | The decision is recorded in security.md and the review queue | done |

### Phase 6: polish

| ID | Package | Lane | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| WP-60 | Polish (item 17): small touches, better wording, and variety in the owner messages so repeated messages do not read the same every week (H6 for every copy change) | Core | WP-35 | The copy changes are queued for the human; end-to-end transcripts show the new wording | todo |

### Future: scheduling

Plan only, no code now (items 17 and 27). Each needs PRD and state-machine changes first.

| ID | Package | Lane | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| WP-70 | The owner picks the exact publishing time instead of choosing from the proposed slots | Core | WP-34 | End-to-end: a post goes live at the owner's time | todo |
| WP-71 | Several posts per day at hours the owner sets | Core | WP-70 | End-to-end: two approved posts on one day publish at their hours | todo |
| WP-72 | AI recommendations for the best hours to post, from the business's past results (a bounded model task through the model layer, H7) | Core | WP-70, WP-48 | The proposal shows the recommended hours; the model output is validated and recorded | todo |

### Phase 7: the agent

Added 2026-11-05 from the human's top priority: make onboarding, data gathering and post creation smarter with a hybrid agent. The design and the human's decisions on it (A1 to A10, 2026-11-05) are in [agent.md](agent.md); H1 for the contracts, H7 for every prompt, H2 for the photo edits and the badge in [design-styles.md](design-styles.md#photo-edits-and-badge). No test may call a real model: every package's tests run on the scripted agent (WP-91) or the model simulator. Each agent flow lands behind its `agent_flows` switch, off by default.

**File ownership.** Every package lists the files it may change; nothing outside them. Rules that keep the parallel packages apart:

- **Contracts first.** WP-89 writes every agent contract file before anything else starts; later packages import them and never edit them (a needed change is reported to the manager and lands as a WP-89 follow-up).
- **Tool registry.** WP-90 creates `src/modules/agent/registry.ts`, which imports a fixed list from `src/modules/agent/agents/index.ts`; WP-90 also creates the three agent files `agents/onboarding.ts`, `agents/weekly.ts`, `agents/drafts.ts` as stubs with empty tool lists, and the tool-group files `tools/shared.ts` (its own tools) plus empty `tools/profile.ts`, `tools/facts.ts`, `tools/plan.ts`, `tools/drafts.ts`. The agent packages then change only their own agent file and tool files; nobody edits `registry.ts`, `agents/index.ts` or the module's `index.ts` after WP-90.
- **Prompts.** Prompt text lives in a migration (`prompt_template` rows are immutable). WP-89's migration `0017_agent_tasks` adds the three task enum values, their `model_task_config` rows (Flash Lite) and a placeholder version 1 prompt per agent that only hands off. Each agent package adds its real prompt as version 2 and makes it active, in one migration named `drizzle/NNNN_agent_<name>_prompt.sql` with its drizzle journal entry; the package that merges later merges `dev` in and renumbers its migration (never rebase).
- **Workflow routing.** Each agent package changes only the routing in its one workflow file, behind its `agent_flows` switch.

| ID | Package | Lane | Files | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- | --- |
| WP-89 | Agent contracts in code, from contracts.md: `AgentContext`, `AgentStep`, the tool union and results, `AgentTurnStopReason`; `DesignSpec`; the three `agent_*` tasks and `image_review` v2 output in the task registry; `RenderRequest`'s optional `edits`, `badge` and `carouselLayout`; the profile's `persona.agentName`; the migration `0017_agent_tasks` (the task enum values, Flash Lite config rows, placeholder prompts) and the model simulator's default for the agent tasks (an unscripted step hands off) | Core | `src/contracts/agent.ts`, `src/contracts/design-spec.ts`, `src/contracts/content.ts` (the content shapes shared by tasks and tools, re-exported by `model-tasks.ts`), `src/contracts/model-tasks.ts`, `src/contracts/providers/renderer.ts`, `src/contracts/business-profile.ts`, their `*.test.ts`; `drizzle/0017_agent_tasks.sql`; `src/simulators/model-fixtures.ts` and `model.test.ts` (defaults only); `src/modules/model-layer/model-layer.db.test.ts` (the seed check) | H1, H4 | Contract tests copy the tables from contracts.md and pass; the renderer and profile changes are optional fields, so nothing else changes | done |
| WP-90 | Agent runtime and tool framework: the agent module (turn loop, lock, context builder, limits, hand-off, `agent_turn` records, `runTurn` called by workflow with injected event callbacks), the registry and stubs above, the shared tools `ask_owner`, `request_photo`, `record_decline`, `hand_off_to_console`, `end_turn`; the migration (`agent_turn`, `agent_config` with the decided limits, `model_run.agent_turn_id`, `post_version.design_spec`, `agent_flows`, `agent_name` default Postly / פוסטלי, `agent_limit`) and grants (the module runs as the `workflow` role; no new login, database-schema.md); the model layer's turn and daily budgets and the refusal of real providers under `NODE_ENV=test` or `CI=true`; the module registration; the console's `agent_limit` items and the turn's steps | Core | `src/modules/agent/` (all of it at first; afterwards only the files above), `src/db/` (schema, grants, least-privilege test), one `drizzle/` migration, `src/modules/model-layer/model-layer.ts` (budgets, provider guard), `src/modules/boundaries.test.ts`, `.dependency-cruiser.mjs`, `src/modules/console/` | WP-89, WP-91, H4 | Scripted turns hit every limit and hand off; a refused call changes nothing; one turn per business; e2e: a scripted agent asks a question and the owner sees it, and a closed window refuses it; the console shows an `agent_limit` item with the turn's steps | done |
| WP-91 | Scripted-agent test harness: a model simulator mode that plays `AgentStep` scripts per agent and turn, fails on an unscripted call, and records the tool calls into the e2e report; a script builder for tests; the playground and sandbox rule agent | Parallel | `src/simulators/model.ts`, `src/simulators/scripted-agent.ts`, `src/simulators/conversational/`, `test/e2e/harness/` | WP-89 | A sample e2e test drives a scripted turn and the report shows the tool calls and results; the playground can play a scripted agent | done |
| WP-92 | Onboarding agent: the `agent_onboarding` prompt (H7), `set_profile_field` with its quote checks, the done rules for `profile_questions` and `brand_assets`, corrections in `profile_review`, the persona name in the intro (feminine Hebrew copy, H6) | Core | `src/modules/agent/agents/onboarding.ts`, `src/modules/agent/tools/profile.ts`, `src/modules/workflow/onboarding.ts` and `onboarding-copy.ts` (routing and persona copy only), `drizzle/NNNN_agent_onboarding_prompt.sql` | WP-90 | E2e on the scripted agent: a vague answer gets a follow-up, a quote that is not in the message is refused, onboarding reaches the style samples; prompt queued under H7 | done |
| WP-93 | Weekly-update agent: the `agent_weekly` prompt (H7), `record_fact` and `plan_posts` with their checks, questions about missing details and photos, `FACTS_EXTRACTED` and `EXTRACTION_FAILED` from the agent | Core | `src/modules/agent/agents/weekly.ts`, `src/modules/agent/tools/facts.ts`, `src/modules/agent/tools/plan.ts`, `src/modules/workflow/weekly.ts` (routing only), `drizzle/NNNN_agent_weekly_prompt.sql` | WP-90 | E2e: an update without an end date gets one question, the answer becomes a fact, the plan is stored; a plan with the wrong count is refused; prompt queued under H7 | done |
| WP-94 | Drafts agent with photo edits and carousel: the `agent_drafts` prompt and `image_review` v2 prompt (H7), `create_draft` and `apply_change` on the existing fact check, version, invalidation and send-with-buttons code; the title and badge fact check; the renderer's `edits` (rotate, crop, tone) and the `numbered` slide counter, and the gallery runner (WP-13) must render badges (a badge on each style and kind) so the human sees them | Core | `src/modules/agent/agents/drafts.ts`, `src/modules/agent/tools/drafts.ts`, `src/modules/workflow/drafts.ts` (routing only), `src/modules/content/fact-check.ts` (title and badge), `src/modules/design/edits.ts`, `src/modules/design/carousel.ts`, `src/modules/design/engine.ts` (calling them), `drizzle/NNNN_agent_drafts_prompt.sql` | WP-90 | E2e: a draft with a straightened, cropped photo and a 3-slide numbered carousel reaches the owner with buttons; "perfect, just add X" makes a new version and only a tap approves it; screenshots in the report; prompts queued under H7 | done |
| WP-95 | Badge design element: the badge in each style template with the contrast, size, placement and text-area checks, from design-styles.md | Parallel | `src/modules/design/badge.ts`, `src/modules/design/styles/` | WP-89 | Every style renders each badge kind on the example set within the rules, checked by the rules tests and the gallery | done |
| WP-96 | Optional manual eval: `scripts/eval-agent.ts` and `npm run eval:agent`, opt-in by `POSTLY_AGENT_EVAL=1`, a spend cap, the example set's conversations against real Gemini, an HTML report; a test that no CI workflow or `npm run check` references it | Parallel | `scripts/eval-agent.ts`, `scripts/eval-agent.test.ts`, `fixtures/example-set/` (conversation scripts), `package.json` (script only) | WP-92, WP-93, WP-94 | The human can run it once and read the report; CI never runs it | todo |
| WP-97 | Follow-up (A8, A10): if Flash Lite proves too weak in the WP-96 eval or in dev use (refusals, hand-offs, or captions the human rejects), compare a larger history window and Gemini Flash on the same eval and propose a change to the human; configuration only unless the context builder needs a new limit | Core | `agent_config` and `model_task_config` (a migration), `src/modules/agent/context.ts` if needed | WP-96 and dev use | The comparison report is in front of the human and the decision is recorded in agent.md | todo |

Parallel plan: WP-89 first (small). Then WP-91 and WP-95 at once, and WP-90 once WP-91 lands. Then WP-92, WP-93 and WP-94 in parallel on the disjoint files above; each merges `dev` in when another lands, never rebases. WP-96 comes last, and WP-97 only if its trigger fires. WP-94's `engine.ts` change and WP-95's `styles/` change meet only through the badge's render hook that WP-95 adds in `badge.ts`; WP-94 calls it when it exists. Retiring the one-shot tasks (A9) is a later cleanup package.

### Phase 8: before the first real environment

Added 2026-11-06 from the human's request for fewer migrations, so that a new environment starts from one clean script. Allowed only while no environment holds real customer data: dev is throwaway, and stage and prod have never been applied. Once the first environment with customers exists, migrations are append-only and never squashed again.

| ID | Package | Lane | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| WP-98 | Squash every migration in `drizzle/` (0000 up to the last one on `dev`) into one baseline migration that builds the full schema, roles, grants, RLS policies and seed rows of today's chain, and, in the same rewrite, apply the schema cleanup the human chose on 2026-11-07 (docs first in database-schema.md, H4): (a) `message.from_phone` and `to_phone` become one `counterpart_phone` (the business number is known from the business; the `phone_lookup` role's column grant moves with it), and `message.payload` keeps only the fields the code reads; (b) `weekly_update.original_text` points to its source message ids instead of copying their text (the voice-note `transcript` stays, it exists nowhere else; `message` is never partitioned or archived, WP-100, so the source text stays reachable); (c) the uuid arrays `message.media_asset_ids` and `weekly_update.media_asset_ids` become link tables with composite `(business_id, id)` foreign keys; (d) Postgres enums become `text` with a CHECK constraint, so a new value no longer needs an enum migration. Record in deployment.md how dev's existing database moves to the baseline: recreate it, or mark the baseline as applied only after comparing it with dev's live schema (`pg_dump --schema-only`). Migrations stay append-only from then on | Core | the open PRs that add migrations merged first; no other migration in flight | A test proves the baseline builds the intended schema (a `pg_dump --schema-only` comparison against the old chain plus the listed changes, roles and policies included); every db and e2e test passes on it; the human reviews it as an H4 item | todo |

### Phase 9: storage that grows

Added 2026-11-07 from the human's review of the database design. The human's rule: **nothing done for or by a customer is deleted for space**; old data moves to cheaper, slower storage that can still be read. This does not change the cancellation rule in PRD.md (data deleted 30 days after cancellation, provisional), which stays until the human decides it separately. Docs first for each package (database-schema.md, technical-design.md, deployment.md, with Hebrew summaries); H4 for the migrations, H8 for the storage and access.

| ID | Package | Lane | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| WP-99 | Model and agent bodies out of Postgres: `model_run.input` and `output`, and `agent_turn.steps`, are written as gzipped JSON to a private Cloud Storage bucket through a storage interface in the model layer and agent module, one object per row under `<business id>/<table>/<row id>` (a model run with no business, such as an unknown number's, goes under `system/`). The row keeps the metadata (task, model, prompt version, attempt, tokens, cost, ms, valid, error) and the object path. **The bucket lifecycle never deletes**: it moves objects to Nearline after 30 days, Coldline after 90 and Archive after 365 (those classes bill a minimum of 30, 90 and 365 days, so an early delete still costs the minimum). The one delete path is the existing cancellation deletion (WP-43, PRD's rule while the human keeps it): it removes a deleted business's prefix together with its rows. Reads go through one function that fetches the object whatever its class; the console's model-run and agent-turn detail views use it. Only the web, worker and console accounts read the bucket, and only the worker writes and the deletion job deletes, in Terraform (never applied by an agent) | Parallel | WP-98 | A db test stores and reads back a model run and an agent turn through the interface; a deletion test shows a cancelled business past `data_delete_after` loses its rows and its whole object prefix while another business's objects stay; the e2e suite passes on the simulator storage; the console detail views show the bodies; the Terraform plan shows the bucket, lifecycle rules with no delete action, and the grants above | todo |
| WP-100 | Monthly partitions for the append-only tables **that no other table references by foreign key**: `model_run`, `workflow_event` and `console_action` (range-partitioned on `created_at`), with RLS, grants and indexes on every partition and a monthly job that creates next month's partition ahead of time. `message` and `agent_turn` are **not** partitioned: `approval` and `preference_rule` reference `message` by `(business_id, id)` (an approval's message is its evidence), and a partitioned table's unique key would have to include its partition column; their bulk leaves Postgres through WP-98's slimmer `payload` and WP-99. Partitions older than a configured age (12 months by default) are exported to Parquet in a Coldline Cloud Storage bucket, checked row for row (counts and checksums), and only then detached and dropped; the exports stay readable through a BigQuery external table. **Deletion carries through:** for a cancelled business past `data_delete_after`, the deletion job also rewrites the archived `model_run` and `console_action` files without that business's rows; `workflow_event` archives keep them, as database-schema.md and retention-checks.md say for the table. The BigQuery dataset has no RLS, so read access is limited to the console team and recorded as H8 | Core | WP-98, WP-99 | A db test proves RLS and grants hold on a new partition, and that no partitioned table is the target of a foreign key; the partition job is idempotent; an export test round-trips a partition to Parquet and compares counts and checksums before the drop; a deletion test shows a cancelled business's rows gone from the archived `model_run` and `console_action` files and still present in `workflow_event`'s; the runbook says how to query or restore an archived month | todo |

## Session manager

The manager is one long-running Claude session that owns this plan. It does not write product code.

### Loop

1. **Pick.** List packages whose dependencies are `done` and whose gates have passed. Take at most one core package if no core session is running, and fill free parallel slots (up to three) with parallel packages that touch disjoint files.
2. **Start.** Start one session per package in its own worktree with the brief below, naming its [lane](#change-size-lanes). For a hotfix, start its reviewer at the same time. Set the package to `in_progress` on the board.
3. **Wait.** Do nothing until a session reports. Never poll.
4. **Verify.** (Reviewer session under the [operating mode](#operating-mode).) On a report: start a reviewer that did not write the code, with the [reviewer brief](#reviewer-brief). CI's `check` on the PR's head SHA is the full gate (nobody re-runs `npm run check` locally to verify); the reviewer opens the end-to-end report from the CI artifact and reviews by area (security, tenant isolation, failure cases) where the package touches them.
5. **Gate.** If the package touches a human-review area, or adds or changes an end-to-end test, show the human the diff summary, the test, and its report. Under the operating mode, the PR's own review-queue file (`docs/review-queue/pr-<N>.md`) stands in for waiting, unless the gate spends money or deploys. Set the package to `review` on the board.
6. **Merge.** After approval (the reviewer's, under the operating mode), the reviewer posts the `review` status on the approved SHA and turns on auto-merge; GitHub squash-merges into `dev` when `check` and `review` are green there (until the [switch-over](#operating-mode) is done, the merge-queue session merges instead). The manager then sets the package to `done` on the board, and in this plan in its next batched status PR.
7. **Repeat** from step 1. When nothing is ready and nothing is running, list the open human gates and decisions to the human and stop.

A session that reports a doc gap or a failing end-to-end test is not retried blindly: the manager brings it to the human, updates the docs and their Hebrew companions once decided, and then restarts the package.

### Session brief template

```text
Package: <id> <name> (lane: <core|parallel>; change size: <normal|docs-only|hotfix>)
Start: git fetch origin && git checkout -B <branch> origin/dev
Read first: CLAUDE.md, PRD.md, technical-design.md, agentic-development.md, <contract doc>, implementation-plan.md (<id>).
Scope: <files and folders this package may change>. Anything else: report, do not change. Never edit implementation-plan.md or its summary.
Steps: confirm the docs cover the work; write failing tests; implement; add or update the end-to-end test and run that test locally; run npm run check:local before pushing (npm run fmt:infra first if you touched infra/). CI runs npm run check and is the gate.
Done when: <done criterion from the table>, and check is green on the PR.
Human gates: <gates>. Under the operating mode, queue them in docs/review-queue/pr-<N>.md (add it once the PR has its number); stop only for money or deployment, or if the human-owned tests are not yet merged.
Deliver: branch wp/<id>-<slug>, a pull request with the template filled in (e2e report, gate areas, "needs terraform apply", "has a migration"), the end-to-end report sent with SendUserFile, and a short report of anything left open.
```

### Reviewer brief

The manager starts a reviewer with this brief (for a hotfix, before the PR opens, with the diagnosis instead of the PR number). The reviewer is never the session that wrote the change.

```text
Review: PR #<N> <title>, lane <normal|docs-only|hotfix>. Review the head SHA you read: <SHA> = gh pr view <N> --json headRefOid.
Read: CLAUDE.md, the three source-of-truth docs, the contract doc the PR touches, and every changed file.
Check: the PR template is filled in and matches the diff ("needs terraform apply", "has a migration", gate areas); check is green on <SHA>; the e2e report (CI artifact e2e-report) for every e2e test added or changed; docs/review-queue/pr-<N>.md for every human-review area touched (npm run lint:review-queue checks its front matter); for the docs-only lane, npm run lane:docs-only -- --base origin/dev passes.
Comment: one grouped review comment, blocking and non-blocking findings with file:line, starting "APPROVED <SHA>" or "CHANGES REQUESTED".
If nothing blocks:
  gh api repos/ShmuelRob/postly/statuses/<SHA> -f state=success -f context=review -f description="Approved by <reviewer>"
  gh pr merge <N> --auto --squash --delete-branch --match-head-commit <SHA>
If gh pr merge --auto is refused because auto-merge is not on yet, tell the merge-queue session the PR and the SHA instead.
A new push to the PR has no review status: review the delta and post the status again on the new SHA.
```

## Recommended start

Waves are what can run together. The core lane and the parallel lane run side by side.

1. WP-01 alone, since every package builds on its folders and rules.
2. Core lane: WP-02, then WP-20, WP-21, WP-22, WP-23. Parallel lane, at the same time: WP-03, WP-10, and WP-11.
3. Parallel lane: the three style sessions of WP-12, then WP-13. This produces the first gallery for review.
4. Phase 3 in order on the core lane, with WP-45, WP-40, and WP-41 on the parallel lane alongside it. WP-45 comes first, so the human can test each flow locally as it lands.
